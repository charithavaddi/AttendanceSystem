# Online Attendance Management System
Sankar Matriculation School, Sankagiri West, Namakkal District, Tamil Nadu

Node.js + Express API, PostgreSQL, and a browser front end (plain HTML/CSS/JS, no build step).
One service serves both the API and the web pages, so it deploys as a single web app.

## Run locally
1. Install Node.js 18+ and PostgreSQL 12+. Create an empty database.
2. Copy `.env.example` and set the variables in your shell or your host's dashboard.
3. `npm install` then `npm start`, and open http://localhost:3000
The schema (`schema.sql`) is applied automatically at start-up. On an empty database the server creates the admin account and a demo teacher, class and students.

## Demo logins (change after first login)
- Administrator: `admin` / `Admin@123` (or the value of `ADMIN_PASSWORD`)
- Teacher: `teacher1` / `Teacher@123`

## Environment variables
DATABASE_URL, DATABASE_SSL (true/false), JWT_SECRET, ADMIN_PASSWORD, SEED_DEMO, SCHOOL_TZ, PORT.
Start command: `npm start`. Health check: `/healthz`.
