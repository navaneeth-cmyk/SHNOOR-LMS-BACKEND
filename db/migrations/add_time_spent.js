import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../../.env') });

async function migrate() {
    try {
        const { default: pool } = await import('../postgres.js');
        console.log("Starting migration: Add time_spent_seconds to module_progress...");

        await pool.query(`
            ALTER TABLE module_progress 
            ADD COLUMN IF NOT EXISTS time_spent_seconds INTEGER DEFAULT 0;
        `);

        console.log("✅ Column added successfully!");
        process.exit(0);
    } catch (err) {
        console.error("❌ Migration failed:", err);
        process.exit(1);
    }
}

migrate();