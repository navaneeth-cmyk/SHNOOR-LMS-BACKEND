import 'dotenv/config';
import pool from '../db/postgres.js';

async function checkExams() {
    try {
        const exams = await pool.query('SELECT exam_id, title FROM exams WHERE title ILIKE \'%PRACTICE%\'');
        console.log('--- EXAMS ---');
        console.log(JSON.stringify(exams.rows, null, 2));

        const violations = await pool.query('SELECT COUNT(*), exam_id FROM exam_violations GROUP BY exam_id');
        console.log('\n--- VIOLATION COUNTS BY EXAM_ID ---');
        console.log(JSON.stringify(violations.rows, null, 2));

        console.log('\n--- DETAILED SAMPLE VIOLATIONS ---');
        const sampled = await pool.query(`
      SELECT v.violation_id, v.exam_id, e.title as exam_title, u.full_name as student_name, u.role
      FROM exam_violations v
      LEFT JOIN exams e ON v.exam_id::text = e.exam_id::text
      LEFT JOIN users u ON v.student_id = u.user_id
      LIMIT 10
    `);
        console.log(JSON.stringify(sampled.rows, null, 2));

        const students = await pool.query("SELECT COUNT(*) FROM users WHERE role = 'student'");
        console.log('\n--- STUDENT COUNT ---');
        console.log(JSON.stringify(students.rows[0], null, 2));

        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}

checkExams();