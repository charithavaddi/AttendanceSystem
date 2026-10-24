'use strict';
const $ = (s, r = document) => r.querySelector(s);
// Builds DOM with textContent only, so user data can never inject HTML.
const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'class') e.className = v;
    else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c !== false && c != null) e.append(c.nodeType ? c : document.createTextNode(c));
  return e;
};
const view = (...k) => $('#main').replaceChildren(...k);
const iso = d => d.toLocaleDateString('en-CA');
const label = c => `Class ${c.grade}-${c.section}`;
const STAT = [['present', 'Present'], ['absent', 'Absent'], ['leave', 'Leave']];
const LOW = 75;
let token = sessionStorage.getItem('t'), me = JSON.parse(sessionStorage.getItem('u') || 'null'), tab = 'attendance';

function toast(m, bad) {
  const t = $('#toast'); t.textContent = m; t.className = bad ? 'bad show' : 'show';
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.className = ''; }, 3500);
}
const guard = f => async (...a) => { try { await f(...a); } catch (e) { toast(e.message, true); } };
async function api(path, o = {}) {
  const r = await fetch('/api' + path, {
    method: o.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: o.body ? JSON.stringify(o.body) : undefined
  });
  if (r.status === 401 && token) { logout(); throw new Error('Session ended. Sign in again.'); }
  if (o.raw && r.ok) return r;
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'Something went wrong.');
  return d;
}
async function download(r, name) {
  const a = h('a', { href: URL.createObjectURL(await r.blob()), download: name });
  document.body.append(a); a.click(); a.remove();
}
const field = (l, input) => h('label', {}, h('span', {}, l), input);
const opt = (v, t) => h('option', { value: v }, t);

function logout() { sessionStorage.clear(); token = me = null; boot(); }
function boot() { me ? shell() : loginView(); }

function loginView() {
  $('#top').replaceChildren();
  view(h('section', { class: 'login' },
    h('h1', {}, 'Sankar Matriculation School'), h('p', { class: 'sub' }, 'Attendance system · Sankagiri West, Namakkal'),
    h('form', {
      onsubmit: guard(async e => {
        e.preventDefault(); const f = new FormData(e.target);
        const d = await api('/login', { method: 'POST', body: { username: f.get('username'), password: f.get('password') } });
        token = d.token; me = d.user; sessionStorage.setItem('t', token); sessionStorage.setItem('u', JSON.stringify(me)); tab = 'attendance'; boot();
      })
    },
      field('Username', h('input', { name: 'username', autocomplete: 'username', autocapitalize: 'none', required: true })),
      field('Password', h('input', { name: 'password', type: 'password', autocomplete: 'current-password', required: true })),
      h('button', { class: 'primary' }, 'Sign in'))));
}

const TABS = [['attendance', 'Mark attendance', attendanceView], ['reports', 'Reports', reportsView], ['students', 'Students', studentsView],
  ['setup', 'Classes & subjects', setupView, 1], ['teachers', 'Teachers', teachersView, 1], ['backup', 'Backup', backupView, 1]];
function shell() {
  const tabs = TABS.filter(t => !t[3] || me.role === 'admin');
  $('#top').replaceChildren(
    h('div', { class: 'bar' }, h('strong', {}, 'Sankar Matriculation School'), h('span', {}, me.name), h('button', { class: 'link', onclick: logout }, 'Sign out')),
    h('nav', {}, tabs.map(t => h('button', { class: t[0] === tab ? 'on' : '', 'aria-current': t[0] === tab ? 'page' : null, onclick: () => { tab = t[0]; shell(); } }, t[1]))));
  guard((tabs.find(t => t[0] === tab) || tabs[0])[2])();
}

async function attendanceView() {
  const classes = await api('/classes');
  if (!classes.length) return view(h('p', { class: 'empty' }, 'No classes are assigned to you yet. Ask the administrator.'));
  const sel = h('select', {}, classes.map(c => opt(c.id, label(c)))), date = h('input', { type: 'date', value: iso(new Date()), max: iso(new Date()) });
  const list = h('div', { class: 'roster' }), summary = h('p', { class: 'sub', 'aria-live': 'polite' });
  let rows = []; const st = {};
  const draw = () => {
    list.replaceChildren(...rows.map(r => h('div', { class: 'stu' },
      h('div', {}, h('div', { class: 'nm' }, r.name), h('div', { class: 'adm' }, 'Admission no. ' + r.admission_no)),
      h('div', { class: 'seg', role: 'group', 'aria-label': 'Status for ' + r.name },
        STAT.map(([k, t]) => h('button', { class: k + (st[r.student_id] === k ? ' on' : ''), 'aria-pressed': String(st[r.student_id] === k), onclick: () => { st[r.student_id] = k; draw(); } }, t))))));
    const n = k => rows.filter(r => st[r.student_id] === k).length;
    summary.textContent = rows.length ? `${n('present')} present, ${n('absent')} absent, ${n('leave')} on leave, ${rows.length - n('present') - n('absent') - n('leave')} not marked` : '';
  };
  const load = guard(async () => {
    rows = await api(`/attendance?class_id=${sel.value}&date=${date.value}`);
    for (const k in st) delete st[k];
    rows.forEach(r => { if (r.status) st[r.student_id] = r.status; });
    draw();
    if (!rows.length) list.replaceChildren(h('p', { class: 'empty' }, 'This class has no students yet. Ask the administrator to add them.'));
  });
  sel.onchange = date.onchange = load;
  view(h('h2', {}, 'Mark attendance'), h('div', { class: 'row' }, field('Class', sel), field('Date', date)), summary, list,
    h('div', { class: 'bottom' },
      h('button', { class: 'sec', onclick: () => { rows.forEach(r => { st[r.student_id] = 'present'; }); draw(); } }, 'Mark all present'),
      h('button', {
        class: 'primary', onclick: guard(async () => {
          const left = rows.filter(r => !st[r.student_id]).length;
          if (!rows.length) return;
          if (left) throw new Error(`Mark ${left} more student${left > 1 ? 's' : ''} before saving.`);
          await api('/attendance', { method: 'PUT', body: { class_id: +sel.value, date: date.value, records: rows.map(r => ({ student_id: r.student_id, status: st[r.student_id] })) } });
          toast('Attendance saved.');
        })
      }, 'Save attendance')));
  load();
}

async function reportsView() {
  const classes = await api('/classes');
  if (!classes.length) return view(h('p', { class: 'empty' }, 'No classes are available.'));
  const sel = h('select', {}, classes.map(c => opt(c.id, label(c)))), from = h('input', { type: 'date' }), to = h('input', { type: 'date' });
  const preset = h('select', {}, [['today', 'Today'], ['week', 'This week'], ['month', 'This month'], ['custom', 'Custom dates']].map(([v, t]) => opt(v, t)));
  const name = h('input', { type: 'search', placeholder: 'Filter by student name' }), body = h('tbody'), detail = h('div');
  let data = [];
  const setRange = () => {
    const n = new Date(), p = preset.value;
    if (p === 'today') from.value = to.value = iso(n);
    if (p === 'week') { const m = new Date(n); m.setDate(n.getDate() - ((n.getDay() + 6) % 7)); from.value = iso(m); to.value = iso(n); }
    if (p === 'month') { from.value = iso(new Date(n.getFullYear(), n.getMonth(), 1)); to.value = iso(n); }
  };
  const draw = () => {
    const f = name.value.trim().toLowerCase(), rows = data.filter(r => r.name.toLowerCase().includes(f));
    body.replaceChildren(...(rows.length ? rows.map(r => h('tr', {},
      h('td', {}, r.admission_no),
      h('td', {}, h('button', { class: 'link', onclick: guard(() => student(r)) }, r.name)),
      h('td', { class: 'n' }, r.present), h('td', { class: 'n' }, r.absent), h('td', { class: 'n' }, r.leave),
      h('td', { class: 'n' }, r.percentage == null ? '–' : h('span', { class: r.percentage < LOW ? 'low' : '' }, r.percentage + '%' + (r.percentage < LOW ? ` (below ${LOW}%)` : '')))))
      : [h('tr', {}, h('td', { colspan: 6 }, 'No students match.'))]));
  };
  const qs = () => `class_id=${sel.value}&from=${from.value}&to=${to.value}`;
  const load = guard(async () => { detail.replaceChildren(); data = await api('/reports/class?' + qs()); draw(); });
  const student = async r => {
    const d = await api(`/reports/student/${r.id}?from=${from.value}&to=${to.value}`);
    detail.replaceChildren(h('div', { class: 'card' }, h('h2', {}, `${d.student.name}: ${from.value} to ${to.value}`),
      h('p', {}, `Present ${d.present}, absent ${d.absent}, leave ${d.leave}. Attendance ${d.percentage == null ? 'not available' : d.percentage + '%'}.`),
      d.records.length ? h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Date'), h('th', {}, 'Status'))),
        h('tbody', {}, d.records.map(x => h('tr', {}, h('td', {}, x.date), h('td', {}, x.status[0].toUpperCase() + x.status.slice(1))))))) : h('p', { class: 'empty' }, 'No records in this period.')));
    detail.scrollIntoView({ behavior: 'smooth' });
  };
  preset.onchange = () => { setRange(); load(); };
  from.onchange = to.onchange = () => { preset.value = 'custom'; load(); };
  sel.onchange = load; name.oninput = draw; preset.value = 'week'; setRange();
  view(h('h2', {}, 'Attendance reports'),
    h('div', { class: 'card grid' }, field('Class', sel), field('Period', preset), field('From', from), field('To', to), field('Student', name)),
    h('div', { class: 'row' }, h('button', { class: 'sec', onclick: guard(async () => download(await api('/reports/class?format=csv&' + qs(), { raw: true }), `attendance_${from.value}_${to.value}.csv`)) }, 'Download CSV'),
      h('button', { class: 'sec', onclick: () => window.print() }, 'Print')),
    h('p', { class: 'sub' }, 'Attendance % = present ÷ (present + absent). Leave days are excused and not counted against the student.'),
    h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, ['Admission no.', 'Name'].map(t => h('th', {}, t)), ['Present', 'Absent', 'Leave', 'Attendance'].map(t => h('th', { class: 'n' }, t)))), body)), detail);
  load();
}

async function studentsView() {
  const classes = await api('/classes'), adm = me.role === 'admin';
  const opts = () => classes.map(c => opt(c.id, label(c)));
  const search = h('input', { type: 'search', placeholder: 'Search name or admission no.' }), cls = h('select', {}, opt('', 'All classes'), opts());
  const inact = h('input', { type: 'checkbox' }), body = h('tbody');
  const f = { a: h('input', { required: true, maxlength: 30 }), n: h('input', { required: true, maxlength: 100 }), c: h('select', { required: true }, opts()) };
  const submit = h('button', { class: 'primary' }, 'Add student'), cancel = h('button', { type: 'button', class: 'link', hidden: true }, 'Cancel');
  let editing = null;
  const reset = () => { editing = null; f.a.value = f.n.value = ''; submit.textContent = 'Add student'; cancel.hidden = true; };
  cancel.onclick = reset;
  const save = (s, patch) => api('/students/' + s.id, { method: 'PUT', body: { admission_no: s.admission_no, name: s.name, class_id: s.class_id, active: s.active, ...patch } });
  const load = guard(async () => {
    const rows = await api('/students?' + new URLSearchParams({ search: search.value, class_id: cls.value, all: inact.checked ? '1' : '' }));
    body.replaceChildren(...(rows.length ? rows.map(s => h('tr', { class: s.active ? '' : 'off' },
      h('td', {}, s.admission_no), h('td', {}, s.name), h('td', {}, label(s)),
      adm && h('td', { class: 'acts' },
        h('button', { class: 'link', onclick: () => { editing = s; f.a.value = s.admission_no; f.n.value = s.name; f.c.value = s.class_id; submit.textContent = 'Save changes'; cancel.hidden = false; f.n.focus(); } }, 'Edit'),
        s.active ? h('button', { class: 'link danger', onclick: guard(async () => { if (!confirm(`Deactivate ${s.name}? Past attendance is kept.`)) return; await api('/students/' + s.id, { method: 'DELETE' }); load(); }) }, 'Deactivate')
          : h('button', { class: 'link', onclick: guard(async () => { await save(s, { active: true }); load(); }) }, 'Reactivate'))))
      : [h('tr', {}, h('td', { colspan: 4 }, 'No students match.'))]));
  });
  let t; search.oninput = () => { clearTimeout(t); t = setTimeout(load, 250); }; cls.onchange = inact.onchange = load;
  view(h('h2', {}, 'Students'),
    h('div', { class: 'filters' }, search, cls, adm && h('label', { class: 'chk' }, inact, ' Show inactive')),
    adm && (classes.length ? h('form', {
      class: 'card grid', onsubmit: guard(async e => {
        e.preventDefault();
        const body = { admission_no: f.a.value, name: f.n.value, class_id: +f.c.value };
        if (editing) await save(editing, body); else await api('/students', { method: 'POST', body });
        toast('Student saved.'); reset(); load();
      })
    }, field('Admission no.', f.a), field('Name', f.n), field('Class', f.c), h('div', { class: 'row' }, submit, cancel))
      : h('p', { class: 'empty' }, 'Add a class first (Classes & subjects tab).')),
    h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, ['Admission no.', 'Name', 'Class', adm && ''].map(x => x !== false && h('th', {}, x)))), body)));
  load();
}

async function setupView() {
  const box = h('div');
  const draw = guard(async () => {
    const [classes, subjects] = await Promise.all([api('/classes'), api('/subjects')]);
    const grade = h('select', {}, Array.from({ length: 12 }, (_, i) => opt(i + 1, 'Class ' + (i + 1)))), section = h('input', { required: true, maxlength: 5, size: 4 });
    const sub = h('input', { required: true, maxlength: 60 });
    const del = (path, what) => guard(async () => { if (!confirm(`Delete ${what}?`)) return; await api(path, { method: 'DELETE' }); draw(); });
    const list = (items, path, txt) => h('ul', {}, items.map(i => h('li', {}, txt(i), ' ', h('button', { class: 'link danger', onclick: del(path + i.id, txt(i)) }, 'Delete'))));
    box.replaceChildren(
      h('h2', {}, 'Classes and sections'),
      h('form', { class: 'row', onsubmit: guard(async e => { e.preventDefault(); await api('/classes', { method: 'POST', body: { grade: +grade.value, section: section.value } }); draw(); }) },
        field('Class', grade), field('Section', section), h('button', { class: 'primary' }, 'Add class')),
      classes.length ? list(classes, '/classes/', label) : h('p', { class: 'empty' }, 'No classes yet.'),
      h('h2', {}, 'Subjects'),
      h('form', { class: 'row', onsubmit: guard(async e => { e.preventDefault(); await api('/subjects', { method: 'POST', body: { name: sub.value } }); draw(); }) },
        field('Subject name', sub), h('button', { class: 'primary' }, 'Add subject')),
      subjects.length ? list(subjects, '/subjects/', s => s.name) : h('p', { class: 'empty' }, 'No subjects yet.'));
  });
  view(box); draw();
}

async function teachersView() {
  const box = h('div');
  const draw = guard(async () => {
    const [teachers, classes] = await Promise.all([api('/teachers'), api('/classes')]);
    let editing = null;
    const f = { u: h('input', { required: true, maxlength: 50, autocapitalize: 'none' }), n: h('input', { required: true, maxlength: 100 }), p: h('input', { type: 'password', minlength: 8, required: true, autocomplete: 'new-password' }), a: h('input', { type: 'checkbox', checked: true }) };
    const checks = classes.map(c => [c, h('input', { type: 'checkbox' })]);
    const submit = h('button', { class: 'primary' }, 'Add teacher'), cancel = h('button', { type: 'button', class: 'link', hidden: true, onclick: () => draw() }, 'Cancel');
    const edit = t => {
      editing = t; f.u.value = t.username; f.u.disabled = true; f.n.value = t.name; f.p.value = ''; f.p.required = false; f.a.checked = t.active;
      checks.forEach(([c, i]) => { i.checked = t.class_ids.includes(c.id); }); submit.textContent = 'Save changes'; cancel.hidden = false; f.n.focus();
    };
    box.replaceChildren(h('h2', {}, 'Teachers'),
      h('form', {
        class: 'card', onsubmit: guard(async e => {
          e.preventDefault();
          const class_ids = checks.filter(([, i]) => i.checked).map(([c]) => c.id);
          if (editing) await api('/teachers/' + editing.id, { method: 'PUT', body: { name: f.n.value, password: f.p.value, active: f.a.checked, class_ids } });
          else await api('/teachers', { method: 'POST', body: { username: f.u.value, name: f.n.value, password: f.p.value, class_ids } });
          toast('Teacher saved.'); draw();
        })
      },
        h('div', { class: 'card grid', style: 'margin:0;padding:0;border:0' }, field('Username', f.u), field('Full name', f.n), field('Password (min 8 characters; leave blank to keep)', f.p)),
        h('label', { class: 'chk' }, f.a, ' Account active'),
        h('div', {}, h('span', { class: 'sub' }, 'Classes this teacher can mark'), h('div', { class: 'checks' }, checks.map(([c, i]) => h('label', { class: 'chk' }, i, label(c))))),
        h('div', { class: 'row' }, submit, cancel)),
      h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, ['Name', 'Username', 'Classes', 'Status', ''].map(x => h('th', {}, x)))),
        h('tbody', {}, teachers.map(t => h('tr', { class: t.active ? '' : 'off' }, h('td', {}, t.name), h('td', {}, t.username),
          h('td', {}, classes.filter(c => t.class_ids.includes(c.id)).map(label).join(', ') || 'None'), h('td', {}, t.active ? 'Active' : 'Inactive'),
          h('td', {}, h('button', { class: 'link', onclick: () => edit(t) }, 'Edit'))))))));
  });
  view(box); draw();
}

function backupView() {
  view(h('h2', {}, 'Backup'),
    h('p', {}, 'Download all classes, students, teachers (without passwords) and attendance records as one JSON file. Keep a copy somewhere safe each week.'),
    h('button', { class: 'primary', onclick: guard(async () => download(await api('/backup', { raw: true }), `attendance-backup-${iso(new Date())}.json`)) }, 'Download backup'));
}

boot();
