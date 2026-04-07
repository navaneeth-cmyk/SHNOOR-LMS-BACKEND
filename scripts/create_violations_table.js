import pool from "../db/postgres.js";

async function createTable() {
  try {
    console.log("Checking for exam_violations table...");
    await pool.query(`
      CREATE TABLE IF NOT EXISTS exam_violations (
        violation_id SERIAL PRIMARY KEY,
        exam_id INT NOT NULL,
        student_id UUID NOT NULL,
        violation_type VARCHAR(50) NOT NULL,
        details JSONB,
        created_at TIMESTAMP DEFAULT NOW(),
        /* No hard foreign keys if they cause type conflicts or if tables are in different schemas/instances, 
           but keep student_id as UUID since the error confirmed users.user_id is uuid */
        FOREIGN KEY (student_id) REFERENCES users(user_id) ON DELETE CASCADE
      );
    `);
    console.log("✓ exam_violations table ready.");
    process.exit(0);
  } catch (err) {
    console.error("Error creating table:", err);
    process.exit(1);
  }
}

createTable();