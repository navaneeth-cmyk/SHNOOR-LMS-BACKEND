import "dotenv/config";
import pool from "../db/postgres.js";

async function fixExamTypes() {
  try {
    console.log("--- [MIGRATION] Fixing exam_type classification ---");

    await pool.query(`
      UPDATE exams
      SET exam_type = 'exam'
      WHERE exam_type IS NULL OR exam_type NOT IN ('exam', 'contest')
    `);

    const relabelResult = await pool.query(`
      UPDATE exams e
      SET exam_type = 'exam'
      WHERE e.exam_type = 'contest'
        AND EXISTS (
          SELECT 1 FROM exam_questions eq WHERE eq.exam_id = e.exam_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM contest_questions cq WHERE cq.exam_id = e.exam_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM contest_submissions cs WHERE cs.contest_id = e.exam_id
        )
      RETURNING e.exam_id
    `);

    await pool.query(`
      ALTER TABLE exams
      ALTER COLUMN exam_type SET DEFAULT 'exam'
    `);

    const counts = await pool.query(`
      SELECT exam_type, COUNT(*)::int AS count
      FROM exams
      GROUP BY exam_type
      ORDER BY exam_type
    `);

    console.log(`✓ Reclassified ${relabelResult.rowCount} exam rows from contest -> exam`);
    console.table(counts.rows);
    console.log("✅ exam_type fix completed.");
    process.exit(0);
  } catch (error) {
    console.error("❌ fix_exam_type_classification failed:", error.message);
    process.exit(1);
  }
}

fixExamTypes();
