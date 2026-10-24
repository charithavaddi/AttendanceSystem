'use strict';
const express = require('express'), helmet = require('helmet'), rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs'), jwt = require('jsonwebtoken'), pg = require('pg'), { z } = require('zod');
const fs = require('fs'), path = require('path'), crypto = require('crypto');

pg.types.setTypeParser(1082, v => v); // keep DATE columns as 'YYYY-MM-DD' strings
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  max: process.env.VERCEL ? 3 : 10 // serverless: keep few connections per instance
});
const SECRET = process.env.JWT_SECRET || (console.warn('JWT_SECRET not set: using a temporary key.'), crypto.randomBytes(32).toString('hex'));
const TZ = process.env.SCHOOL_TZ || 'Asia/Kolkata';
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });

// ---------- helpers ----------
const q = (t, p) => pool.query(t, p).then(r => r.rows);
const wrap = f => (req, res, next) => Promise.resolve(f(req, res, next)).catch(next);
async function tx(fn) {
  const c = await pool.connect();
  try { await c.query('begin'); const r = await fn(c); await c.query('commit'); return r; }
  catch (e) { await c.query('rollback'); throw e; } finally { c.release(); }
}
const pct = (p, a) => (p + a ? Math.round(p / (p + a) * 1000) / 10 : null); // leave is excused: not in the denominator
const csv = rows => rows.map(r => r.map(v => {
  v = String(v ?? ''); if (/^[=+\-@]/.test(v)) v = "'" + v;           // block spreadsheet formula injection
  return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}).join(',')).join('\r\n');

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD');
const pw = z.string().min(8, 'needs at least 8 characters').max(100);
const ids = z.array(z.number().int()).max(50);
const status = z.enum(['present', 'absent', 'leave']);
const range = z.object({ from: date, to: date }).refine(r => r.from <= r.to, 'start date is after end date');

const auth = wrap(async (req, res, next) => {
  let id;
  try { id = jwt.verify((req.headers.authorization || '').slice(7), SECRET).id; }
  catch { return res.status(401).json({ error: 'Session ended. Sign in again.' }); }
  const [u] = await q('select id,name,role from users where id=$1 and active', [id]);
  if (!u) return res.status(401).json({ error: 'Session ended. Sign in again.' });
  req.user = u; next();
});
const admin = (req, res, next) => req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Administrator access required.' });
async function allowed(u, classId) {
  if (u.role === 'admin') return true;
  return (await q('select 1 from teacher_classes where teacher_id=$1 and class_id=$2', [u.id, classId])).length > 0;
}
const need = async (u, classId) => { if (!(await allowed(u, classId))) { const e = new Error('forbidden'); e.status = 403; throw e; } };

// ---------- app ----------
const app = express();
app.set('trust proxy', 1);
app.use(helmet());
app.get('/healthz', (req, res) => res.send('ok'));
const api = express.Router();
api.use(express.json({ limit: '100kb' }));

api.post('/login', rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, message: { error: 'Too many attempts. Wait 15 minutes.' } }), wrap(async (req, res) => {
  const b = z.object({ username: z.string().min(1).max(50), password: z.string().min(1).max(100) }).parse(req.body);
  const [u] = await q('select * from users where username=$1 and active', [b.username.toLowerCase()]);
  if (!u || !(await bcrypt.compare(b.password, u.password_hash))) return res.status(401).json({ error: 'Wrong username or password.' });
  res.json({ token: jwt.sign({ id: u.id }, SECRET, { expiresIn: '8h' }), user: { id: u.id, name: u.name, role: u.role } });
}));
api.use(auth);

// classes
api.get('/classes', wrap(async (req, res) => {
  res.json(req.user.role === 'admin'
    ? await q('select * from classes order by grade,section')
    : await q('select c.* from classes c join teacher_classes t on t.class_id=c.id where t.teacher_id=$1 order by grade,section', [req.user.id]));
}));
api.post('/classes', admin, wrap(async (req, res) => {
  const b = z.object({ grade: z.number().int().min(1).max(12), section: z.string().trim().min(1).max(5) }).parse(req.body);
  await q('insert into classes(grade,section) values($1,$2)', [b.grade, b.section.toUpperCase()]); res.status(201).json({ ok: true });
}));
api.delete('/classes/:id', admin, wrap(async (req, res) => { await q('delete from classes where id=$1', [+req.params.id]); res.json({ ok: true }); }));

// subjects
api.get('/subjects', wrap(async (req, res) => res.json(await q('select * from subjects order by name'))));
api.post('/subjects', admin, wrap(async (req, res) => {
  const b = z.object({ name: z.string().trim().min(1).max(60) }).parse(req.body);
  await q('insert into subjects(name) values($1)', [b.name]); res.status(201).json({ ok: true });
}));
api.delete('/subjects/:id', admin, wrap(async (req, res) => { await q('delete from subjects where id=$1', [+req.params.id]); res.json({ ok: true }); }));

// teachers
const setClasses = (c, id, list) => c.query('delete from teacher_classes where teacher_id=$1', [id])
  .then(() => list.length && c.query('insert into teacher_classes select $1, unnest($2::int[])', [id, list]));
api.get('/teachers', admin, wrap(async (req, res) => res.json(await q(
  `select u.id,u.username,u.name,u.active,coalesce(array_agg(t.class_id) filter (where t.class_id is not null),'{}') class_ids
   from users u left join teacher_classes t on t.teacher_id=u.id where u.role='teacher' group by u.id order by u.name`))));
api.post('/teachers', admin, wrap(async (req, res) => {
  const b = z.object({ username: z.string().min(3).max(50).regex(/^[a-z0-9._-]+$/i, 'letters, numbers . _ - only'), name: z.string().trim().min(1).max(100), password: pw, class_ids: ids }).parse(req.body);
  const hash = await bcrypt.hash(b.password, 10);
  await tx(async c => {
    const { rows: [u] } = await c.query("insert into users(username,name,password_hash,role) values($1,$2,$3,'teacher') returning id", [b.username.toLowerCase(), b.name, hash]);
    await setClasses(c, u.id, b.class_ids);
  });
  res.status(201).json({ ok: true });
}));
api.put('/teachers/:id', admin, wrap(async (req, res) => {
  const id = +req.params.id;
  const b = z.object({ name: z.string().trim().min(1).max(100), password: pw.optional().or(z.literal('')), active: z.boolean(), class_ids: ids }).parse(req.body);
  await tx(async c => {
    if (b.password) await c.query("update users set name=$2,active=$3,password_hash=$4 where id=$1 and role='teacher'", [id, b.name, b.active, await bcrypt.hash(b.password, 10)]);
    else await c.query("update users set name=$2,active=$3 where id=$1 and role='teacher'", [id, b.name, b.active]);
    await setClasses(c, id, b.class_ids);
  });
  res.json({ ok: true });
}));

// students
const stu = z.object({ admission_no: z.string().trim().min(1).max(30), name: z.string().trim().min(1).max(100), class_id: z.number().int(), active: z.boolean().optional() });
api.get('/students', wrap(async (req, res) => {
  const p = [], w = [];
  if (req.user.role !== 'admin') { p.push(req.user.id); w.push(`s.class_id in (select class_id from teacher_classes where teacher_id=$${p.length})`); }
  if (req.query.class_id) { p.push(+req.query.class_id); w.push(`s.class_id=$${p.length}`); }
  if (req.query.search) { p.push('%' + String(req.query.search).slice(0, 60) + '%'); w.push(`(s.name ilike $${p.length} or s.admission_no ilike $${p.length})`); }
  if (!(req.user.role === 'admin' && req.query.all === '1')) w.push('s.active');
  res.json(await q(`select s.id,s.admission_no,s.name,s.class_id,s.active,c.grade,c.section from students s join classes c on c.id=s.class_id
    ${w.length ? 'where ' + w.join(' and ') : ''} order by c.grade,c.section,s.name limit 500`, p));
}));
api.post('/students', admin, wrap(async (req, res) => {
  const b = stu.parse(req.body);
  await q('insert into students(admission_no,name,class_id) values($1,$2,$3)', [b.admission_no, b.name, b.class_id]); res.status(201).json({ ok: true });
}));
api.put('/students/:id', admin, wrap(async (req, res) => {
  const b = stu.parse(req.body);
  await q('update students set admission_no=$2,name=$3,class_id=$4,active=$5 where id=$1', [+req.params.id, b.admission_no, b.name, b.class_id, b.active ?? true]); res.json({ ok: true });
}));
api.delete('/students/:id', admin, wrap(async (req, res) => { await q('update students set active=false where id=$1', [+req.params.id]); res.json({ ok: true }); }));

// attendance
api.get('/attendance', wrap(async (req, res) => {
  const b = z.object({ class_id: z.coerce.number().int(), date }).parse(req.query);
  await need(req.user, b.class_id);
  res.json(await q(`select s.id student_id,s.admission_no,s.name,a.status from students s
    left join attendance a on a.student_id=s.id and a.date=$2 where s.class_id=$1 and s.active order by s.name`, [b.class_id, b.date]));
}));
api.put('/attendance', wrap(async (req, res) => {
  const b = z.object({ class_id: z.number().int(), date, records: z.array(z.object({ student_id: z.number().int(), status })).min(1).max(200) }).parse(req.body);
  if (b.date > today()) return res.status(400).json({ error: 'You cannot mark attendance for a future date.' });
  await need(req.user, b.class_id);
  await q(`insert into attendance(student_id,date,status,marked_by)
    select s.id,$2,r.status,$3 from students s join unnest($4::int[],$5::text[]) as r(id,status) on r.id=s.id where s.class_id=$1 and s.active
    on conflict (student_id,date) do update set status=excluded.status,marked_by=excluded.marked_by,updated_at=now()`,
    [b.class_id, b.date, req.user.id, b.records.map(r => r.student_id), b.records.map(r => r.status)]);
  res.json({ ok: true });
}));

// reports
api.get('/reports/class', wrap(async (req, res) => {
  const b = range.and(z.object({ class_id: z.coerce.number().int() })).parse(req.query);
  await need(req.user, b.class_id);
  const rows = (await q(`select s.id,s.admission_no,s.name,
      (count(*) filter (where a.status='present'))::int present,(count(*) filter (where a.status='absent'))::int absent,(count(*) filter (where a.status='leave'))::int leave
    from students s left join attendance a on a.student_id=s.id and a.date between $2 and $3
    where s.class_id=$1 and s.active group by s.id order by s.name`, [b.class_id, b.from, b.to])).map(r => ({ ...r, percentage: pct(r.present, r.absent) }));
  if (req.query.format === 'csv') {
    res.type('text/csv').attachment(`attendance_${b.from}_${b.to}.csv`)
      .send(csv([['Admission no', 'Name', 'Present', 'Absent', 'Leave', 'Attendance %'], ...rows.map(r => [r.admission_no, r.name, r.present, r.absent, r.leave, r.percentage ?? ''])]));
  } else res.json(rows);
}));
api.get('/reports/student/:id', wrap(async (req, res) => {
  const b = range.parse(req.query);
  const [s] = await q('select id,admission_no,name,class_id from students where id=$1', [+req.params.id]);
  if (!s) return res.status(404).json({ error: 'Student not found.' });
  await need(req.user, s.class_id);
  const records = await q('select date,status from attendance where student_id=$1 and date between $2 and $3 order by date', [s.id, b.from, b.to]);
  const n = k => records.filter(r => r.status === k).length;
  res.json({ student: s, records, present: n('present'), absent: n('absent'), leave: n('leave'), percentage: pct(n('present'), n('absent')) });
}));

// backup (no password hashes)
api.get('/backup', admin, wrap(async (req, res) => {
  const out = { exported_at: new Date().toISOString() };
  out.users = await q('select id,username,name,role,active from users');
  for (const t of ['classes', 'subjects', 'teacher_classes', 'students', 'attendance']) out[t] = await q(`select * from ${t}`);
  res.attachment(`attendance-backup-${today()}.json`).json(out);
}));

// Create tables and seed on first use (works on a normal server and on serverless hosts)
let ready;
const init = () => ready || (ready = (async () => {
  await pool.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  await seed();
})().catch(e => { ready = null; throw e; }));
app.use('/api', (req, res, next) => init().then(() => next(), next), api);
app.use(express.static(path.join(__dirname, 'public')));
app.use((err, req, res, next) => {
  if (err.status === 403) return res.status(403).json({ error: 'You do not have access to this class.' });
  if (err instanceof z.ZodError) { const i = err.issues[0]; return res.status(400).json({ error: `${i.path.join('.') || 'Input'}: ${i.message}` }); }
  if (err.code === '23505') return res.status(409).json({ error: 'That value already exists.' });
  if (err.code === '23503') return res.status(409).json({ error: 'This item is still in use. Remove what depends on it first.' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Bad request.' });
  console.error(err); res.status(500).json({ error: 'Server error. Try again.' });
});

// ---------- start-up ----------
async function seed() {
  if ((await q('select 1 from users limit 1')).length) return;
  await q("insert into users(username,name,password_hash,role) values('admin','School Administrator',$1,'admin')", [await bcrypt.hash(process.env.ADMIN_PASSWORD || 'Admin@123', 10)]);
  if (process.env.SEED_DEMO === 'false') return;
  const [c] = await q("insert into classes(grade,section) values(6,'A') returning id");
  const [t] = await q("insert into users(username,name,password_hash,role) values('teacher1','Demo Teacher',$1,'teacher') returning id", [await bcrypt.hash('Teacher@123', 10)]);
  await q('insert into teacher_classes values($1,$2)', [t.id, c.id]);
  for (const [no, name] of [['S001', 'Aarav Kumar'], ['S002', 'Divya Lakshmi'], ['S003', 'Karthik Raja'], ['S004', 'Meena Devi'], ['S005', 'Suresh Babu']])
    await q('insert into students(admission_no,name,class_id) values($1,$2,$3)', [no, name, c.id]);
  console.log('Seeded demo data. Change the default passwords after first login.');
}
module.exports = app; // Vercel uses this export
if (require.main === module) { // normal start: npm start
  init().then(() => app.listen(process.env.PORT || 3000, () => console.log('Attendance system running')))
    .catch(e => { console.error(e); process.exit(1); });
}
