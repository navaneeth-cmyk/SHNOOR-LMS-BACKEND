import "dotenv/config";
import pool from "../db/postgres.js";
import { v4 as uuidv4 } from 'uuid';

async function seedData() {
    try {
        console.log("--- [SEED] Starting Demo Data Seeding (PRACTICE QUIZ Only) ---");

        // 1. Find or Create "PRACTICE QUIZ"
        let examId;
        const examCheck = await pool.query("SELECT exam_id FROM exams WHERE title = 'PRACTICE QUIZ' LIMIT 1");

        if (examCheck.rows.length > 0) {
            examId = examCheck.rows[0].exam_id;
            console.log(`✓ Found existing PRACTICE QUIZ (ID: ${examId})`);
        } else {
            console.log("Creating new PRACTICE QUIZ exam...");
            // Corrected columns based on schema check: 
            // title, description, duration, pass_percentage, status
            const newExamRes = await pool.query(
                "INSERT INTO exams (title, description, duration, pass_percentage, status, exam_type) VALUES ($1, $2, $3, $4, $5, 'exam') RETURNING exam_id",
                ["PRACTICE QUIZ", "General practice assessment for students.", 30, 40, "published"]
            );
            examId = newExamRes.rows[0].exam_id;
            console.log(`✓ Created PRACTICE QUIZ (ID: ${examId})`);
        }

        // 2. Create Dummy Students
        const dummyStudents = [
            { name: "Rahul Sharma", email: "rahul.demo@example.com" },
            { name: "Priya Patel", email: "priya.demo@example.com" },
            { name: "Amit Kumar", email: "amit.demo@example.com" },
            { name: "Sneha Gunda", email: "sneha.demo@example.com" },
            { name: "Vikram Singh", email: "vikram.demo@example.com" },
            { name: "Anjali Devi", email: "anjali.demo@example.com" },
            { name: "Suresh Raina", email: "suresh.demo@example.com" },
            { name: "Meera Bai", email: "meera.demo@example.com" },
            { name: "Karan Johar", email: "karan.demo@example.com" },
            { name: "Deepika P", email: "deepika.demo@example.com" }
        ];

        console.log(`Processing ${dummyStudents.length} dummy students...`);

        for (const student of dummyStudents) {
            // Check if student already exists
            const checkRes = await pool.query("SELECT user_id FROM users WHERE email = $1", [student.email]);
            let studentId;

            if (checkRes.rows.length > 0) {
                studentId = checkRes.rows[0].user_id;
            } else {
                const id = uuidv4();
                await pool.query(
                    "INSERT INTO users (user_id, firebase_uid, full_name, email, role, status) VALUES ($1, $2, $3, $4, 'student', 'active')",
                    [id, `demo_uid_${id.substring(0, 8)}`, student.name, student.email]
                );
                studentId = id;
            }

            // Cleanup old violations for this demo student to avoid duplicates
            await pool.query("DELETE FROM exam_violations WHERE student_id = $1", [studentId]);
            await pool.query("DELETE FROM exam_results WHERE student_id = $1 AND exam_id::text = $2", [studentId, String(examId)]);

            // 3. Create Violation Logs for this student
            const isSerious = Math.random() > 0.6;
            const incidentCount = isSerious ? Math.floor(Math.random() * 10) + 16 : Math.floor(Math.random() * 5) + 1;

            console.log(`Seeding ${incidentCount} incidents for ${student.name} (Serious: ${isSerious})`);

            for (let i = 0; i < incidentCount; i++) {
                const types = ["VOICE_DETECTION", "MULTIPLE_FACES", "NO_FACE_DETECTED", "LOUD_NOISE", "PHONE_DETECTED"];
                let type = types[Math.floor(Math.random() * types.length)];

                if (isSerious && i === 0) type = "PHONE_DETECTED";

                const details = {
                    faceCount: type === "MULTIPLE_FACES" ? 2 : (type === "NO_FACE_DETECTED" ? 0 : 1),
                    timestamp: new Date(Date.now() - Math.random() * 1000000).toISOString(),
                    isPractice: true,
                    voiceDetection: type === "VOICE_DETECTION",
                    objectDetection: type === "PHONE_DETECTED"
                };

                await pool.query(
                    "INSERT INTO exam_violations (exam_id, student_id, violation_type, details, created_at) VALUES ($1, $2, $3, $4, $5)",
                    [examId, studentId, type, JSON.stringify(details), details.timestamp]
                );
            }

            // 4. Create an Exam Result for this student
            const score = Math.floor(Math.random() * 60) + 20;
            const passed = score >= 40;

            // Check the results table schema too... assuming it has common columns
            try {
                await pool.query(
                    "INSERT INTO exam_results (student_id, exam_id, obtained_marks, total_marks, percentage, passed) VALUES ($1, $2, $3, 100, $4, $5)",
                    [studentId, String(examId), score, score, passed]
                );
            } catch (resErr) {
                console.log(`⚠️ Note: Result insertion skipped/failed (likely schema diff): ${resErr.message}`);
            }
        }

        console.log("\n✅ Seeding Complete! All demo data is now under 'PRACTICE QUIZ'.");
        process.exit(0);
    } catch (err) {
        console.error("❌ Seeding Error:", err);
        process.exit(1);
    }
}

seedData();