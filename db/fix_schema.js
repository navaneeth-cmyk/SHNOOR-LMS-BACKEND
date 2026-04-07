import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../.env') });
import pool from './postgres.js';

const runMigration = async () => {
    try {
        console.log('Starting migration...');

        // 1. Add disconnect_grace_time to exams table
        console.log('Adding disconnect_grace_time to exams...');
        await pool.query(`
      ALTER TABLE exams 
      ADD COLUMN IF NOT EXISTS disconnect_grace_time INTEGER DEFAULT 300;
    `);
        console.log('✅ disconnect_grace_time column added to exams table.');

        // 2. Create course_comments table
        console.log('Creating course_comments table...');
        await pool.query(`
      CREATE TABLE IF NOT EXISTS course_comments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        course_id UUID REFERENCES courses(course_id) ON DELETE CASCADE,
        user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
        text TEXT NOT NULL,
        parent_id UUID REFERENCES course_comments(id) ON DELETE CASCADE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);
        console.log('✅ course_comments table created.');

        console.log('Migration completed successfully.');
    } catch (error) {
        console.error('Migration failed:', error);
    } finally {
        pool.end();
    }
};

runMigration();