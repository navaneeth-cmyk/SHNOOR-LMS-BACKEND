import pool from "../db/postgres.js";

/*
  Add one question with options to a contest
  Body:
  {
    questionText: "",
    options: [
      { text: "", isCorrect: true/false },
      ...
    ]
  }
*/

export const addContestQuestion = async (req, res) => {
  const { examId } = req.params;
  const { questionText, options, marks } = req.body;

  if (!questionText || !options || options.length < 2) {
    return res.status(400).json({
      message: "Question text and at least 2 options are required"
    });
  }

  if (!marks || marks <= 0) {
    return res.status(400).json({
      message: "Marks must be greater than 0"
    });
  }

  const correctCount = options.filter(o => o.isCorrect).length;

  if (correctCount !== 1) {
    return res.status(400).json({
      message: "Exactly one option must be correct"
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // insert question with marks
    const qRes = await client.query(
      `
      INSERT INTO contest_questions
        (exam_id, question_text, marks)
      VALUES
        ($1, $2, $3)
      RETURNING question_id
      `,
      [examId, questionText, marks]
    );

    const questionId = qRes.rows[0].question_id;

    // insert options
    for (const opt of options) {
      await client.query(
        `
        INSERT INTO contest_options
          (question_id, option_text, is_correct)
        VALUES
          ($1, $2, $3)
        `,
        [questionId, opt.text, opt.isCorrect]
      );
    }

    await client.query("COMMIT");

    res.status(201).json({
      message: "Question added successfully",
      question_id: questionId,
      marks: marks
    });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("addContestQuestion error:", err.message);
    res.status(500).json({ message: "Failed to add question" });
  } finally {
    client.release();
  }
};