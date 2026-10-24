-- Online Attendance Management System: database schema (PostgreSQL 12+)
-- Safe to run repeatedly; the server applies it at start-up.
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  username      VARCHAR(50) UNIQUE NOT NULL,
  name          VARCHAR(100) NOT NULL,
  password_hash TEXT NOT NULL,
  role          VARCHAR(10) NOT NULL CHECK (role IN ('admin','teacher')),
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS classes (
  id      SERIAL PRIMARY KEY,
  grade   INT NOT NULL CHECK (grade BETWEEN 1 AND 12),
  section VARCHAR(5) NOT NULL,
  UNIQUE (grade, section)
);
CREATE TABLE IF NOT EXISTS subjects (
  id   SERIAL PRIMARY KEY,
  name VARCHAR(60) UNIQUE NOT NULL
);
CREATE TABLE IF NOT EXISTS teacher_classes (
  teacher_id INT REFERENCES users(id)   ON DELETE CASCADE,
  class_id   INT REFERENCES classes(id) ON DELETE CASCADE,
  PRIMARY KEY (teacher_id, class_id)
);
CREATE TABLE IF NOT EXISTS students (
  id           SERIAL PRIMARY KEY,
  admission_no VARCHAR(30) UNIQUE NOT NULL,
  name         VARCHAR(100) NOT NULL,
  class_id     INT NOT NULL REFERENCES classes(id),
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS attendance (
  id         SERIAL PRIMARY KEY,
  student_id INT NOT NULL REFERENCES students(id),
  date       DATE NOT NULL,
  status     VARCHAR(10) NOT NULL CHECK (status IN ('present','absent','leave')),
  marked_by  INT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (student_id, date)
);
CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance(date);
CREATE INDEX IF NOT EXISTS idx_students_class  ON students(class_id);
