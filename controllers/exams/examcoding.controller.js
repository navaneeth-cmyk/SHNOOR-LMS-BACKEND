import pool from "../../db/postgres.js";
export const addCodingQuestion = async (req, res) => {
  const client = await pool.connect();

  try {
    console.log("CODING PAYLOAD >>>", JSON.stringify(req.body, null, 2));

    const { examId } = req.params;
    const {
      title,
      description,
      marks,
      order,
      language,
      starter_code,
      testcases,
    } = req.body;

    if (!title) {
      return res.status(400).json({ message: "Invalid coding question payload: Problem Title is required" });
    }
    if (!description) {
      return res.status(400).json({ message: "Invalid coding question payload: Question Description is required" });
    }
    if (!Array.isArray(testcases) || testcases.length === 0) {
      return res.status(400).json({ message: "Invalid coding question payload: At least one test case is required" });
    }

    for (const tc of testcases) {
      if (
        typeof tc.input !== "string" ||
        typeof tc.expected_output !== "string"
      ) {
        return res.status(400).json({
          message: "Each test case must have input and expected_output",
        });
      }
    }

    await client.query("BEGIN");

    const qRes = await client.query(
      `
      INSERT INTO exam_questions
        (exam_id, question_text, marks, question_order, question_type)
      VALUES ($1, $2, $3, $4, 'coding')
      RETURNING question_id
      `,
      [examId, title, marks ?? 10, order ?? 1],
    );

    const questionId = qRes.rows[0].question_id;

    const codingRes = await client.query(
      `
      INSERT INTO exam_coding_questions
        (question_id, title, description, language, starter_code)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING coding_id
      `,
      [
        questionId,
        title,
        description,
        language?.toLowerCase() || null,
        starter_code || null,
      ],
    );

    const codingId = codingRes.rows[0].coding_id;
    for (const tc of testcases) {
      await client.query(
        `
    INSERT INTO exam_test_cases
      (coding_id, input, expected_output, is_hidden)
    VALUES ($1, $2, $3, $4)
    `,
        [codingId, tc.input, tc.expected_output, tc.is_hidden === true],
      );
    }

    await client.query("COMMIT");

    res.status(201).json({
      message: "Coding question added successfully",
      questionId,
      codingId,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Add coding question error:", err);
    res.status(500).json({ message: err.message });
  } finally {
    client.release();
  }
};