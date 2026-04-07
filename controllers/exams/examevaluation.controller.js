import pool from "../../db/postgres.js";
import { issueExamCertificate } from "../certificate.controller.js";

/**
 * Instructor: Get all submissions for an exam
 */
export const getExamSubmissions = async (req, res) => {
  try {
    const { examId } = req.params;
    const instructorId = req.user.id;

    // Verify exam ownership
    const examCheck = await pool.query(
      `SELECT exam_id FROM exams WHERE exam_id = $1 AND instructor_id = $2`,
      [examId, instructorId]
    );

    if (examCheck.rowCount === 0) {
      return res.status(403).json({ message: "Unauthorized access" });
    }

    const { rows } = await pool.query(
      `
      SELECT
        ea.answer_id,
        ea.student_id,
        u.full_name AS student_name,
        eq.question_id,
        eq.question_text,
        eq.question_type,
        ea.answer_text,
        ea.answer_text AS code_submission,
        ea.marks_obtained,
        eq.marks AS total_marks
      FROM exam_answers ea
      JOIN exam_questions eq ON ea.question_id = eq.question_id
      JOIN users u ON ea.student_id = u.user_id
      WHERE ea.exam_id = $1
      ORDER BY u.full_name, eq.question_order
      `,
      [examId]
    );

    res.json(rows);
  } catch (error) {
    console.error("Get exam submissions error:", error);
    res.status(500).json({ message: "Failed to fetch submissions" });
  }
};

/**
 * Instructor: Evaluate descriptive answer
 */
export const evaluateDescriptiveAnswer = async (req, res) => {
  try {
    const { answerId } = req.params;
    const { marks } = req.body;
    const instructorId = req.user.id;
    const numericMarks = Number(marks);

    if (!Number.isFinite(numericMarks) || numericMarks < 0) {
      return res.status(400).json({ message: "Marks required" });
    }

    const answerCheck = await pool.query(
      `
      SELECT
        ea.answer_id,
        eq.marks AS question_marks
      FROM exam_answers ea
      JOIN exam_questions eq ON eq.question_id = ea.question_id
      JOIN exams e ON e.exam_id = ea.exam_id
      WHERE ea.answer_id = $1
        AND eq.question_type = 'descriptive'
        AND e.instructor_id = $2
      `,
      [answerId, instructorId]
    );

    if (answerCheck.rowCount === 0) {
      return res.status(404).json({ message: "Answer not found" });
    }

    const questionMarks = Number(answerCheck.rows[0].question_marks || 0);
    if (numericMarks > questionMarks) {
      return res.status(400).json({ message: "Marks exceed question maximum" });
    }

    await pool.query(
      `
      UPDATE exam_answers
      SET marks_obtained = $1
      WHERE answer_id = $2
      `,
      [numericMarks, answerId]
    );

    res.json({ message: "Descriptive answer evaluated", marks: numericMarks });
  } catch (error) {
    console.error("Evaluate descriptive error:", error);
    res.status(500).json({ message: "Evaluation failed" });
  }
};

/**
 * Instructor: Evaluate coding answer (manual)
 */
export const evaluateCodingAnswer = async (req, res) => {
  try {
    const { answerId } = req.params;
    const { marks } = req.body;
    const instructorId = req.user.id;
    const numericMarks = Number(marks);

    if (!Number.isFinite(numericMarks) || numericMarks < 0) {
      return res.status(400).json({ message: "Marks required" });
    }

    const answerCheck = await pool.query(
      `
      SELECT
        ea.answer_id,
        eq.marks AS question_marks
      FROM exam_answers ea
      JOIN exam_questions eq ON eq.question_id = ea.question_id
      JOIN exams e ON e.exam_id = ea.exam_id
      WHERE ea.answer_id = $1
        AND eq.question_type = 'coding'
        AND e.instructor_id = $2
      `,
      [answerId, instructorId]
    );

    if (answerCheck.rowCount === 0) {
      return res.status(404).json({ message: "Answer not found" });
    }

    const questionMarks = Number(answerCheck.rows[0].question_marks || 0);
    if (numericMarks > questionMarks) {
      return res.status(400).json({ message: "Marks exceed question maximum" });
    }

    await pool.query(
      `
      UPDATE exam_answers
      SET marks_obtained = $1
      WHERE answer_id = $2
      `,
      [numericMarks, answerId]
    );

    return res.json({ message: "Coding answer evaluated", marks: numericMarks });
  } catch (error) {
    console.error("Evaluate coding error:", error);
    return res.status(500).json({ message: "Evaluation failed" });
  }
};

/**
 * Instructor: Finalize exam result for a student
 */
export const finalizeExamResult = async (req, res) => {
  try {
    const { examId, studentId } = req.params;
    const instructorId = req.user.id;

    const examCheck = await pool.query(
      `
      SELECT pass_percentage
      FROM exams
      WHERE exam_id = $1
        AND instructor_id = $2
      `,
      [examId, instructorId]
    );

    if (examCheck.rowCount === 0) {
      return res.status(403).json({ message: "Unauthorized access" });
    }

    // Calculate total & obtained marks
    const marksResult = await pool.query(
      `
      SELECT
        SUM(eq.marks) AS total_marks,
        SUM(COALESCE(ea.marks_obtained, 0)) AS obtained_marks
      FROM exam_questions eq
      LEFT JOIN exam_answers ea
        ON eq.question_id = ea.question_id
        AND ea.student_id = $2
      WHERE eq.exam_id = $1
        AND eq.question_type IN ('mcq', 'descriptive', 'coding')
      `,
      [examId, studentId]
    );

    const totalMarks = Number(marksResult.rows[0].total_marks || 0);
    const obtainedMarks = Number(marksResult.rows[0].obtained_marks || 0);

    // Get pass percentage
    const passPercentage = Number(examCheck.rows[0].pass_percentage || 0);
    const percentage =
      totalMarks > 0 ? (obtainedMarks / totalMarks) * 100 : 0;

    const passed = percentage >= passPercentage;

    // Upsert result
    await pool.query(
      `
      INSERT INTO exam_results
        (exam_id, student_id, total_marks, obtained_marks, percentage, passed)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (exam_id, student_id)
      DO UPDATE SET
        total_marks = EXCLUDED.total_marks,
        obtained_marks = EXCLUDED.obtained_marks,
        percentage = EXCLUDED.percentage,
        passed = EXCLUDED.passed,
        evaluated_at = NOW()
      `,
      [
        examId,
        studentId,
        totalMarks,
        obtainedMarks,
        percentage,
        passed
      ]
    );

    let certificateIssued = false;
    let certificateInfo = null;

    if (passed) {
      try {
        const certificateResult = await issueExamCertificate({
          userId: studentId,
          examId,
          score: percentage
        });

        if (certificateResult.issued) {
          certificateIssued = true;
          certificateInfo = {
            certificate: certificateResult.certificate,
            filePath: certificateResult.filePath
          };
        }
      } catch (certificateError) {
        console.error("Certificate issuance error:", certificateError);
      }
    }

    res.json({
      message: "Exam result finalized",
      totalMarks,
      obtainedMarks,
      percentage,
      passed,
      certificateIssued,
      certificateInfo
    });
  } catch (error) {
    console.error("Finalize exam error:", error);
    res.status(500).json({ message: "Failed to finalize result" });
  }
};