{/*import pool from "../db/postgres.js";
export const addExamQuestion = async (req, res) => {
  try {
    const { examId } = req.params;
    const { questionText, options, correctOption, marks, order } = req.body;

    if (!questionText || !options || !correctOption) {
      return res.status(400).json({ message: "Invalid question data" });
    }

    const { rows } = await pool.query(
      `
      INSERT INTO exam_questions
        (exam_id, question_text, options, correct_option, marks, question_order)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING question_id
      `,
      [
        examId,
        questionText,
        options,
        correctOption,
        marks || 1,
        order
      ]
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error("Add question error:", err);
    res.status(500).json({ message: "Failed to add question" });
  }
};


export const getExamQuestionsForStudent = async (req, res) => {
  try {
    const { examId } = req.params;

    const { rows } = await pool.query(
      `
      SELECT
        question_id,
        question_text,
        options,
        marks,
        question_order
      FROM exam_questions
      WHERE exam_id = $1
      ORDER BY question_order ASC
      `,
      [examId]
    );

    res.json(rows);
  } catch (err) {
    console.error("Fetch questions error:", err);
    res.status(500).json({ message: "Failed to fetch questions" });
  }
};*/}

import pool from "../../db/postgres.js";
export const addMcqQuestion = async (req, res) => {
  const client = await pool.connect();
  try {
    const { examId } = req.params;
    const { questionText, options, correctOption, marks, order } = req.body;

    // 🔒 STRICT VALIDATION
    if (
      !questionText ||
      !Array.isArray(options) ||
      options.length !== 4 ||
      options.some(o => !o || !o.trim()) ||
      !correctOption ||
      !options.map(o => o.trim()).includes(correctOption.trim())
    ) {
      return res.status(400).json({
        message: "MCQ must have exactly 4 non-empty options",
      });
    }

    await client.query("BEGIN");

    const questionRes = await client.query(
      `
      INSERT INTO exam_questions
        (exam_id, question_text, marks, question_order, question_type)
      VALUES ($1, $2, $3, $4, 'mcq')
      RETURNING question_id
      `,
      [examId, questionText.trim(), marks ?? 1, order ?? 1]
    );

    const questionId = questionRes.rows[0].question_id;

    // ✅ INSERT OPTIONS WITH ORDER
    for (let i = 0; i < options.length; i++) {
      const opt = options[i].trim();

      await client.query(
        `
        INSERT INTO exam_mcq_options
          (question_id, option_text, is_correct, option_order)
        VALUES ($1, $2, $3, $4)
        `,
        [
          questionId,
          opt,
          opt === correctOption.trim(),
          i + 1
        ]
      );
    }

    await client.query("COMMIT");

    res.status(201).json({
      message: "MCQ question added successfully",
      questionId
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Add MCQ error:", err);
    res.status(500).json({ message: "Failed to add MCQ question" });
  } finally {
    client.release();
  }
};


