import pool from "../../db/postgres.js";
import { autoSubmitExam as autoSubmitExamInternal } from "./examSubmission.controller.js";

export const createExam = async (req, res) => {
  try {
    const { title, description, duration, passPercentage, courseId, validity_value, validity_unit } = req.body;
    const instructorId = req.user.id;

    if (!title || !duration || !passPercentage) {
      return res.status(400).json({ message: "Missing required fields" });
    }
    // 🔥 RULE ENFORCEMENT
    if (!courseId) {
      // Standalone exam
      if (!validity_value || !validity_unit) {
        return res.status(400).json({
          message: "Standalone exams must have validity",
        });
      }
    } else {
      // Course-linked exam → force NULL
      if (validity_value || validity_unit) {
        return res.status(400).json({
          message: "Course-linked exams must not have validity",
        });
      }
    }

    const { rows } = await pool.query(
      `
        INSERT INTO exams
          (title, description, duration, pass_percentage, instructor_id, course_id, validity_value, validity_unit, exam_type)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'exam')
        RETURNING exam_id, title, duration, pass_percentage
        `,
      [title, description, duration, passPercentage, instructorId, courseId || null, validity_value || null, validity_unit || null]
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error("Create exam error:", err);
    res.status(500).json({ message: "Failed to create exam", error: err.message });
  }
};

export const getInstructorExams = async (req, res) => {
  try {
    const instructorId = req.user.id;

    const { rows } = await pool.query(
      `
        SELECT exam_id, title, duration, pass_percentage, created_at
        FROM exams
        WHERE instructor_id = $1
          AND exam_type = 'exam'
        ORDER BY created_at DESC
        `,
      [instructorId]
    );

    res.json(rows);
  } catch (err) {
    console.error("Fetch instructor exams error:", err);
    res.status(500).json({ message: "Failed to fetch exams" });
  }
};

export const getAllExamsForStudents = async (req, res) => {
  try {
    const studentId = req.user.id;

    const { rows } = await pool.query(
      `
        SELECT
          e.exam_id,
          e.title,
          e.duration,
          e.pass_percentage,
          (ea.status = 'submitted' OR er.exam_id IS NOT NULL) AS is_completed,
          ea.status AS attempt_status,
          er.percentage,
          er.passed
        FROM exams e
        LEFT JOIN student_courses sc
          ON sc.course_id = e.course_id
          AND sc.student_id = $1
        LEFT JOIN course_assignments ca
          ON ca.course_id = e.course_id
          AND ca.student_id = $1
        LEFT JOIN exam_attempts ea
          ON ea.exam_id = e.exam_id
          AND ea.student_id = $1
        LEFT JOIN exam_results er
          ON er.exam_id = e.exam_id
          AND er.student_id = $1
        WHERE e.exam_type = 'exam'
          AND (
            e.course_id IS NULL
            OR sc.student_id IS NOT NULL
            OR ca.student_id IS NOT NULL
          )
        ORDER BY created_at DESC
        `,
      [studentId]
    );

    res.json(rows);
  } catch (err) {
    console.error("Fetch exams error:", err);
    res.status(500).json({ message: "Failed to fetch exams" });
  }
};

export const setExamGraceTimer = async (req, res) => {
  try {
    let { examId } = req.params;
    if (examId && examId.startsWith("final_")) {
      const courseId = examId.replace("final_", "");
      const { rows: resolvedExams } = await pool.query(
        "SELECT exam_id FROM exams WHERE course_id = $1 LIMIT 1",
        [courseId]
      );
      if (resolvedExams.length) examId = resolvedExams[0].exam_id;
    }
    const { disconnect_grace_time } = req.body;

    // Role check
    if (req.user.role !== "admin") {
      return res.status(403).json({ message: "Only admin can set grace timer" });
    }

    if (!disconnect_grace_time || disconnect_grace_time < 0) {
      return res.status(400).json({ message: "Invalid grace time" });
    }

    const { rowCount } = await pool.query(
      `
      UPDATE exams
      SET disconnect_grace_time = $1
      WHERE exam_id = $2
      `,
      [disconnect_grace_time, examId]
    );

    if (rowCount === 0) {
      return res.status(404).json({ message: "Exam not found" });
    }

    res.json({ message: "Grace timer updated successfully" });
  } catch (err) {
    console.error("Set grace timer error:", err);
    res.status(500).json({ message: "Failed to update grace timer" });
  }
};

export const getAllExamsAdmin = async (req, res) => {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({ message: "Access denied" });
    }

    const { rows } = await pool.query(`
      SELECT exam_id, title, duration, disconnect_grace_time
      FROM exams
      WHERE exam_type = 'exam'
      ORDER BY created_at DESC
    `);

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to fetch exams" });
  }
};

export const saveAnswer = async (req, res) => {
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
        console.log(`🔍 RESOLVED saveAnswer ID from ${examId} to ${resolvedExams[0].exam_id}`);
        examId = resolvedExams[0].exam_id;
      } else {
        examId = courseId;
      }
    }
    const { questionId, selectedOptionId, answerText } = req.body;

    if (!questionId) {
      return res.status(400).json({ message: "Invalid data" });
    }

    // Fetch question type
    const { rows: questionRows } = await pool.query(
      `
      SELECT question_type, marks
      FROM exam_questions
      WHERE question_id = $1
      `,
      [questionId]
    );

    if (!questionRows.length) {
      return res.status(400).json({ message: "Invalid question" });
    }

    const question = questionRows[0];

    let marksObtained = 0;

    if (question.question_type === "mcq") {
      if (!selectedOptionId) {
        return res.status(400).json({ message: "Option required" });
      }

      const { rows } = await pool.query(
        `
        SELECT is_correct
        FROM exam_mcq_options
        WHERE option_id = $1
        AND question_id = $2
        `,
        [selectedOptionId, questionId]
      );

      console.log(`🔍 Checking option validity:`, {
        selectedOptionId,
        questionId,
        types: {
          selectedOptionId: typeof selectedOptionId,
          questionId: typeof questionId
        },
        found: rows.length > 0,
        is_correct: rows.length > 0 ? rows[0].is_correct : null
      });

      if (!rows.length) {
        return res.status(400).json({ message: "Invalid option" });
      }

      marksObtained = rows[0].is_correct ? question.marks : 0;

      console.log(`💾 Saving MCQ answer:`, {
        examId,
        questionId,
        studentId,
        selectedOptionId,
        marksObtained,
        is_correct: rows[0].is_correct
      });

      await pool.query(
        `
        INSERT INTO exam_answers
          (exam_id, question_id, student_id, selected_option_id, answer_text, marks_obtained)
        VALUES ($1, $2, $3, $4, NULL, $5)
        ON CONFLICT ON CONSTRAINT unique_answer_per_question
        DO UPDATE SET
          selected_option_id = EXCLUDED.selected_option_id,
          answer_text = NULL,
          marks_obtained = EXCLUDED.marks_obtained
        `,
        [examId, questionId, studentId, selectedOptionId, marksObtained]
      );

    } else if (question.question_type === "descriptive" || question.question_type === "coding") {

      if (!answerText) {
        return res.status(400).json({ message: "Answer required" });
      }

      await pool.query(
        `
        INSERT INTO exam_answers
          (exam_id, question_id, student_id, selected_option_id, answer_text, marks_obtained)
        VALUES ($1, $2, $3, NULL, $4, 0)
        ON CONFLICT ON CONSTRAINT unique_answer_per_question
        DO UPDATE SET
          answer_text = EXCLUDED.answer_text,
          selected_option_id = NULL
        `,
        [examId, questionId, studentId, answerText]
      );
    }

    res.status(200).json({ message: "Answer saved" });

  } catch (err) {
    console.error("Save answer error:", err);
    res.status(500).json({ message: "Failed to save answer" });
  }
};

export const autoSubmitExam = async (studentId, examId) => {
  await autoSubmitExamInternal(studentId, examId);
};

export const createRewriteAttempt = async (req, res) => {
  const client = await pool.connect();

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
        console.log(`🔍 RESOLVED createRewriteAttempt ID from ${examId} to ${resolvedExams[0].exam_id}`);
        examId = resolvedExams[0].exam_id;
      } else {
        examId = courseId;
      }
    }

    const { rows: examRows } = await client.query(
      `SELECT duration FROM exams WHERE exam_id = $1`,
      [examId]
    );

    if (!examRows.length) {
      return res.status(404).json({ message: "Exam not found" });
    }

    await client.query("BEGIN");

    // Clear previous answers for fresh attempt
    await client.query(
      `
      DELETE FROM exam_answers
      WHERE exam_id = $1 AND student_id = $2
      `,
      [examId, studentId]
    );

    // Reset attempt status to in_progress  
    await client.query(
      `
      INSERT INTO exam_attempts (exam_id, student_id, status, start_time, end_time)
      VALUES ($1, $2, 'in_progress', NOW(), NOW() + ($3 * INTERVAL '1 minute'))
      ON CONFLICT (exam_id, student_id)
      DO UPDATE 
      SET status = 'in_progress',
          submitted_at = NULL,
          start_time = NOW(),
          end_time = NOW() + ($3 * INTERVAL '1 minute'),
          disconnected_at = NULL
      `,
      [examId, studentId, examRows[0].duration]
    );

    await client.query("COMMIT");

    res.status(200).json({
      message: "Rewrite attempt created successfully"
    });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Create rewrite attempt error:", err);
    res.status(500).json({ message: "Failed to create rewrite attempt" });
  } finally {
    client.release();
  }
};

export const getExamStatus = async (req, res) => {
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
        console.log(`🔍 RESOLVED getExamStatus ID from ${examId} to ${resolvedExams[0].exam_id}`);
        examId = resolvedExams[0].exam_id;
      } else {
        examId = courseId;
      }
    }

    const { rows } = await pool.query(
      `SELECT status, submitted_at FROM exam_attempts WHERE exam_id = $1 AND student_id = $2`,
      [examId, studentId]
    );

    if (rows.length === 0) {
      return res.json({ status: 'not_started' });
    }

    res.json({
      status: rows[0].status,
      submitted_at: rows[0].submitted_at
    });
  } catch (err) {
    console.error("Get exam status error:", err);
    res.status(500).json({ message: "Failed to get exam status" });
  }
};

export const getExamAttempt = async (req, res) => {
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
        console.log(`🔍 RESOLVED getExamAttempt ID from ${examId} to ${resolvedExams[0].exam_id}`);
        examId = resolvedExams[0].exam_id;
      } else {
        examId = courseId;
      }
    }

    const { rows } = await pool.query(
      `
      SELECT start_time, end_time, status, NOW() AS server_time
      FROM exam_attempts
      WHERE exam_id = $1 AND student_id = $2
      `,
      [examId, studentId]
    );

    if (!rows.length) {
      return res.status(404).json({ message: "Attempt not found" });
    }

    const response = {
      start_time: rows[0].start_time?.toISOString(),
      end_time: rows[0].end_time?.toISOString(),
      server_time: rows[0].server_time?.toISOString(),
      status: rows[0].status
    };

    console.log("📤 getExamAttempt response:", {
      examId,
      raw: rows[0],
      converted: response,
      duration_seconds: Math.floor((new Date(response.end_time) - new Date(response.start_time)) / 1000),
      remaining_seconds: Math.floor((new Date(response.end_time) - new Date(response.server_time)) / 1000)
    });

    res.json(response);
  } catch (err) {
    console.error("Get exam attempt error:", err);
    res.status(500).json({ message: "Failed to get exam attempt" });
  }
};