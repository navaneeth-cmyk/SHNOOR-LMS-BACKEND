import pool from "../../db/postgres.js";

/**
 * ===============================
 * STUDENT: Get my exam results
 * ===============================
 * Shows score, pass/fail, evaluated status
 */
export const getMyExamResults = async (req, res) => {
  try {
    const studentId = req.user.id;

    const { rows } = await pool.query(
      `
      SELECT
        er.exam_id,
        e.title AS exam_title,
        e.duration,
        e.pass_percentage,
        er.total_marks,
        er.obtained_marks,
        er.percentage,
        er.passed,
        er.evaluated_at
      FROM exam_results er
      JOIN exams e ON e.exam_id = er.exam_id
      WHERE er.student_id = $1
      ORDER BY er.evaluated_at DESC
      `,
      [studentId]
    );

    res.status(200).json(rows);
  } catch (err) {
    console.error("getMyExamResults error:", err);
    res.status(500).json({ message: "Failed to fetch exam results" });
  }
};

/**
 * ======================================
 * STUDENT: Get result for single exam
 * ======================================
 */
export const getMyExamResultByExam = async (req, res) => {
  try {
    const studentId = req.user.id;
    let { examId } = req.params;

    if (examId && examId.startsWith("final_")) {
      const courseId = examId.replace("final_", "");
      const { rows: resolvedExams } = await pool.query(
        `
        SELECT e.exam_id 
        FROM exams e
        LEFT JOIN exam_attempts ea ON ea.exam_id = e.exam_id AND ea.student_id = $2
        WHERE e.course_id = $1
        ORDER BY (ea.exam_id IS NOT NULL) DESC, e.created_at DESC
        LIMIT 1
        `,
        [courseId, studentId]
      );
      if (resolvedExams.length) {
        console.log(`🔍 RESOLVED getMyExamResultByExam ID from ${examId} to ${resolvedExams[0].exam_id}`);
        examId = resolvedExams[0].exam_id;
      }
    }

    const { rows } = await pool.query(
      `
      SELECT
        er.exam_id,
        e.title AS exam_title,
        e.pass_percentage,
        er.total_marks,
        er.obtained_marks,
        er.percentage,
        er.passed,
        er.evaluated_at
      FROM exam_results er
      JOIN exams e ON e.exam_id = er.exam_id
      WHERE er.student_id = $1
        AND er.exam_id = $2
      LIMIT 1
      `,
      [studentId, examId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "Result not found" });
    }

    res.status(200).json(rows[0]);
  } catch (err) {
    console.error("getMyExamResultByExam error:", err);
    res.status(500).json({ message: "Failed to fetch exam result" });
  }
};

/**
 * ======================================
 * INSTRUCTOR: Get results for an exam
 * ======================================
 */
export const getExamResultsForInstructor = async (req, res) => {
  try {
    const instructorId = req.user.id;
    const { examId } = req.params;

    // 🔐 Ensure exam belongs to instructor
    const examCheck = await pool.query(
      `
      SELECT exam_id
      FROM exams
      WHERE exam_id = $1 AND instructor_id = $2
      `,
      [examId, instructorId]
    );

    if (examCheck.rows.length === 0) {
      return res.status(403).json({ message: "Unauthorized access" });
    }

    const { rows } = await pool.query(
      `
      SELECT
        u.user_id AS student_id,
        u.full_name AS student_name,
        u.email,
        er.total_marks,
        er.obtained_marks,
        er.percentage,
        er.passed,
        er.evaluated_at
      FROM exam_results er
      JOIN users u ON u.user_id = er.student_id
      WHERE er.exam_id = $1
      ORDER BY er.evaluated_at DESC
      `,
      [examId]
    );

    res.status(200).json(rows);
  } catch (err) {
    console.error("getExamResultsForInstructor error:", err);
    res.status(500).json({ message: "Failed to fetch exam results" });
  }
};

/**
 * ======================================
 * ADMIN: Get results for an exam
 * ======================================
 */
export const getExamResultsForAdmin = async (req, res) => {
  try {
    const { examId } = req.params;

    const examCheck = await pool.query(
      `
      SELECT exam_id
      FROM exams
      WHERE exam_id = $1
      `,
      [examId]
    );

    if (examCheck.rows.length === 0) {
      return res.status(404).json({ message: "Exam not found" });
    }

    const { rows } = await pool.query(
      `
      SELECT
        u.user_id AS student_id,
        u.full_name AS student_name,
        u.email,
        er.total_marks,
        er.obtained_marks,
        er.percentage,
        er.passed,
        er.evaluated_at
      FROM exam_results er
      JOIN users u ON u.user_id = er.student_id
      WHERE er.exam_id = $1
      ORDER BY er.evaluated_at DESC
      `,
      [examId]
    );

    res.status(200).json(rows);
  } catch (err) {
    console.error("getExamResultsForAdmin error:", err);
    res.status(500).json({ message: "Failed to fetch exam results" });
  }
};