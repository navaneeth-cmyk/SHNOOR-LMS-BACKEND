import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import dotenv from "dotenv";
import pkg from "pg";
const { Pool } = pkg;

// Resolve __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Find .env file by searching through parent directories
function loadEnv() {
    let currentPath = __dirname;
    while (currentPath !== path.parse(currentPath).root) {
        const envPath = path.join(currentPath, ".env");
        if (fs.existsSync(envPath)) {
            console.log(`✓ Loading environment from: ${envPath}`);
            dotenv.config({ path: envPath });
            return true;
        }
        currentPath = path.dirname(currentPath);
    }
    return false;
}

if (!loadEnv()) {
    console.warn("⚠️ Warning: .env file not found. Database connection might fail.");
}

async function checkViolations() {
    let client;
    try {
        const dbConfig = {
            host: process.env.DB_HOST || 'localhost',
            port: process.env.DB_PORT || 5432,
            database: process.env.DB_NAME || 'shnoor_db',
            user: process.env.DB_USER || 'postgres',
            password: String(process.env.DB_PASSWORD || ""),
            ssl: false // Force SSL false for local verification
        };

        console.log(`Connecting to: ${dbConfig.host}:${dbConfig.port}, DB: ${dbConfig.database}, User: ${dbConfig.user}`);

        const pool = new Pool(dbConfig);

        console.log("Fetching latest 10 violations from database...");

        client = await pool.connect();

        const { rows } = await client.query(`
      SELECT 
        v.violation_id,
        v.violation_type,
        v.created_at,
        u.full_name AS student_name,
        e.title AS exam_title,
        v.details
      FROM exam_violations v
      JOIN users u ON v.student_id = u.user_id
      LEFT JOIN exams e ON v.exam_id::text = e.exam_id::text
      ORDER BY v.created_at DESC
      LIMIT 10;
    `);

        if (rows.length === 0) {
            console.log("\n⚠️ No violations found in database yet. Try triggering one from the student side!");
        } else {
            console.table(rows.map(r => ({
                ID: r.violation_id,
                Type: r.violation_type,
                Student: r.student_name,
                Exam: r.exam_title,
                Time: new Date(r.created_at).toLocaleString()
            })));
            console.log("\n(Run this script again after triggering a violation)");
        }
    } catch (err) {
        console.error("\n❌ Error:", err.message);
    } finally {
        if (client) client.release();
        process.exit(0);
    }
}

checkViolations();