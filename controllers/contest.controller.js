import pool from "../db/postgres.js";
import { runCodeWithTestCases } from "./contestAdvanced.controller.js";

/* =========================
   ASYNC CODE GRADING QUEUE
========================= */
// Helper to grade coding answer asynchronously
const gradeCodeAsync = async (submissionId, questionId, code, language) => {
  try {
    // Get test cases
    const tcRes = await pool.query(
      `
      SELECT input, expected_output, is_hidden
      FROM contest_test_cases
      WHERE coding_id = (
        SELECT coding_id
        FROM contest_coding_questions
        WHERE question_id = $1
      )
      ORDER BY created_at
      `,
      [questionId]
    );

    if (tcRes.rowCount === 0) return;

    // Get question marks
    const qRes = await pool.query(
      `SELECT marks FROM contest_questions WHERE question_id = $1`,
      [questionId]
    );

    const marks = qRes.rowCount > 0 ? qRes.rows[0].marks || 1 : 1;

    // Run code and get results
    const { testResults, marksObtained } = await runCodeWithTestCases(
      code,
      language,
      tcRes.rows,
      marks
    );

    // Update the submission answer with marks - check if test_results column exists first
    try {
      const columnCheck = await pool.query(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = 'contest_submission_answers' AND column_name = 'test_results'
      `);

      const hasTestResultsColumn = columnCheck.rowCount > 0;

      if (hasTestResultsColumn) {
        await pool.query(
          `
          UPDATE contest_submission_answers
          SET marks_obtained = $1, test_results = $2
          WHERE submission_id = $3 AND question_id = $4
          `,
          [marksObtained, JSON.stringify(testResults), submissionId, questionId]
        );
      } else {
        // Column doesn't exist, update without it
        await pool.query(
          `
          UPDATE contest_submission_answers
          SET marks_obtained = $1
          WHERE submission_id = $2 AND question_id = $3
          `,
          [marksObtained, submissionId, questionId]
        );
      }
    } catch (updateErr) {
      console.error("Error updating submission answer:", updateErr.message);
    }

  } catch (err) {
    console.error("Error grading code asynchronously:", err.message);
    // Log error but don't fail the submission
  }
};

/* =========================
   CREATE WEEKLY CONTEST
========================= */
export const createContest = async (req, res) => {
  try {
    const instructorId = req.user.id;

    const {
      title,
      description,
      courseId,
      duration,
      validityValue,
      validityUnit,
      passPercentage
    } = req.body;

    if (!title || !duration || !validityValue || !validityUnit) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    const result = await pool.query(
      `
      INSERT INTO exams
        (title, description, course_id, instructor_id, duration,
         validity_value, validity_unit, pass_percentage, exam_type, created_at)
      VALUES
        ($1,$2,$3,$4,$5,$6,$7,$8,'contest', NOW())
      RETURNING *
      `,
      [
        title,
        description || null,
        courseId || null,
        instructorId,
        duration,
        validityValue,
        validityUnit,
        passPercentage || null
      ]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error("createContest error:", error.message);
    res.status(500).json({ message: error.message });
  }
};

/* =========================
   GET MY CONTESTS
========================= */
export const getMyContests = async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT 
        e.*,
        (SELECT COUNT(DISTINCT student_id) 
         FROM contest_submissions 
         WHERE contest_id = e.exam_id) AS participants_count
      FROM exams e
      WHERE e.instructor_id = $1
        AND e.exam_type = 'contest'
      ORDER BY e.created_at DESC
      `,
      [req.user.id]
    );

    res.json(result.rows);
  } catch (error) {
    console.error("getMyContests error:", error.message);
    res.status(500).json({ message: error.message });
  }
};

/* =========================
   GET AVAILABLE CONTESTS
========================= */
export const getAvailableContests = async (req, res) => {
  try {
    const studentId = req.user.id;

    const result = await pool.query(
      `
      SELECT e.*,
        CASE WHEN cs.submission_id IS NOT NULL THEN true ELSE false END AS is_submitted
      FROM exams e
      LEFT JOIN contest_submissions cs
        ON cs.contest_id = e.exam_id
        AND cs.student_id = $1
      WHERE e.exam_type = 'contest'
      ORDER BY e.created_at DESC
      `,
      [studentId]
    );

    res.json(result.rows);
  } catch (error) {
    console.error("getAvailableContests error:", error.message);
    res.status(500).json({ message: error.message });
  }
};

/* =========================
   GET CONTEST BY ID
========================= */
export const getContestById = async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `
      SELECT *
      FROM exams
      WHERE exam_id = $1
        AND exam_type = 'contest'
      `,
      [id]
    );

    if (!result.rowCount) {
      return res.status(404).json({ message: "Contest not found" });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error("getContestById error:", error.message);
    res.status(500).json({ message: "Failed to load contest" });
  }
};

/* =========================
   DELETE CONTEST
========================= */
export const deleteContest = async (req, res) => {
  try {
    const contestId = req.params.id;
    const instructorId = req.user.id;

    const result = await pool.query(
      `
      DELETE FROM exams
      WHERE exam_id = $1
        AND instructor_id = $2
        AND exam_type = 'contest'
      RETURNING *
      `,
      [contestId, instructorId]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        message: "Contest not found or not authorized"
      });
    }

    res.json({ message: "Contest deleted successfully" });
  } catch (error) {
    console.error("deleteContest error:", error.message);
    res.status(500).json({ message: error.message });
  }
};

/* =========================
   UPDATE CONTEST
========================= */
export const updateContest = async (req, res) => {
  try {
    const contestId = req.params.id;
    const instructorId = req.user.id;

    const {
      title,
      description,
      duration,
      validityValue,
      validityUnit,
      passPercentage,
      courseId
    } = req.body;

    const result = await pool.query(
      `
      UPDATE exams
      SET
        title = COALESCE($1, title),
        description = COALESCE($2, description),
        duration = COALESCE($3, duration),
        validity_value = COALESCE($4, validity_value),
        validity_unit = COALESCE($5, validity_unit),
        pass_percentage = COALESCE($6, pass_percentage),
        course_id = COALESCE($7, course_id)
      WHERE exam_id = $8
        AND instructor_id = $9
        AND exam_type = 'contest'
      RETURNING *
      `,
      [
        title || null,
        description || null,
        duration || null,
        validityValue || null,
        validityUnit || null,
        passPercentage || null,
        courseId || null,
        contestId,
        instructorId
      ]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        message: "Contest not found or not authorized"
      });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error("updateContest error:", error.message);
    res.status(500).json({ message: error.message });
  }
};

/* =========================
   ADD MCQ QUESTION
========================= */
export const addQuestionToContest = async (req, res) => {
  const client = await pool.connect();

  try {
    const instructorId = req.user.id;
    const { contestId } = req.params;
    const { questionText, options, marks } = req.body;

    if (!questionText || !Array.isArray(options) || options.length < 2) {
      return res.status(400).json({
        message: "Question text and at least 2 options are required"
      });
    }

    if (!marks || marks <= 0) {
      return res.status(400).json({
        message: "Marks must be greater than 0"
      });
    }

    const correctCount = options.filter(o => o.isCorrect === true).length;

    if (correctCount !== 1) {
      return res.status(400).json({
        message: "Exactly one option must be marked as correct"
      });
    }

    await client.query("BEGIN");

    const contestCheck = await client.query(
      `
      SELECT exam_id
      FROM exams
      WHERE exam_id = $1
        AND instructor_id = $2
        AND exam_type = 'contest'
      `,
      [contestId, instructorId]
    );

    if (!contestCheck.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        message: "Contest not found or not authorized"
      });
    }

    const questionResult = await client.query(
      `
      INSERT INTO contest_questions
        (exam_id, question_text, question_type, marks)
      VALUES ($1,$2,'mcq',$3)
      RETURNING question_id
      `,
      [contestId, questionText, marks]
    );

    const questionId = questionResult.rows[0].question_id;

    for (const opt of options) {
      await client.query(
        `
        INSERT INTO contest_options
          (question_id, option_text, is_correct)
        VALUES ($1,$2,$3)
        `,
        [questionId, opt.text, opt.isCorrect === true]
      );
    }

    await client.query("COMMIT");

    res.status(201).json({ questionId, marks });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("addQuestionToContest error:", error.message);
    res.status(500).json({ message: error.message });
  } finally {
    client.release();
  }
};

/* =========================
   GET QUESTIONS FOR STUDENT
========================= */
export const getContestQuestionsForStudent = async (req, res) => {
  try {
    const { contestId } = req.params;

    const result = await pool.query(
      `
      SELECT
        q.question_id,
        q.question_text,
        q.question_type,
        q.marks,
        q.keywords,
        q.created_at,
        COALESCE(
          json_agg(
            json_build_object(
              'option_id', o.option_id,
              'option_text', o.option_text
            )
          ) FILTER (WHERE o.option_id IS NOT NULL AND q.question_type = 'mcq'),
          '[]'::json
        ) AS options,
        cq.coding_id,
        cq.title AS coding_title,
        cq.description AS coding_description,
        cq.language,
        cq.starter_code
      FROM contest_questions q
      LEFT JOIN contest_options o
        ON o.question_id = q.question_id
      LEFT JOIN contest_coding_questions cq
        ON cq.question_id = q.question_id
      WHERE q.exam_id = $1
      GROUP BY q.question_id, q.question_text, q.question_type, q.marks, q.keywords, q.created_at, cq.coding_id, cq.title, cq.description, cq.language, cq.starter_code
      ORDER BY q.created_at ASC
      `,
      [contestId]
    );

    res.json(result.rows);
  } catch (error) {
    console.error("getContestQuestionsForStudent error:", error.message);
    res.status(500).json({ message: error.message });
  }
};

/* =========================
   SUBMIT CONTEST
========================= */
export const submitContestAnswers = async (req, res) => {
  const client = await pool.connect();

  try {
    const studentId = req.user.id;
    const { contestId } = req.params;
    const { answers } = req.body;

    if (!answers || typeof answers !== "object") {
      return res.status(400).json({ message: "Answers required" });
    }

    await client.query("BEGIN");

    const already = await client.query(
      `
      SELECT submission_id
      FROM contest_submissions
      WHERE contest_id = $1
        AND student_id = $2
      `,
      [contestId, studentId]
    );

    // If already submitted, delete old submission and answers so we can re-submit
    if (already.rowCount > 0) {
      const oldSubId = already.rows[0].submission_id;
      await client.query(
        `DELETE FROM contest_submission_answers WHERE submission_id = $1`,
        [oldSubId]
      );
      await client.query(
        `DELETE FROM contest_submissions WHERE submission_id = $1`,
        [oldSubId]
      );
    }

    const subRes = await client.query(
      `
      INSERT INTO contest_submissions (contest_id, student_id)
      VALUES ($1,$2)
      RETURNING submission_id
      `,
      [contestId, studentId]
    );

    const submissionId = subRes.rows[0].submission_id;

    // Get all questions with their complete data
    const qRes = await client.query(
      `
      SELECT 
        cq.question_id,
        cq.question_type,
        cq.marks,
        cq.keywords,
        ccq.language
      FROM contest_questions cq
      LEFT JOIN contest_coding_questions ccq ON cq.question_id = ccq.question_id
      WHERE cq.exam_id = $1
      ORDER BY cq.question_id
      `,
      [contestId]
    );

    console.log("Questions found:", qRes.rowCount, "Total questions to grade");

    // Check if test_results column exists in contest_submission_answers
    let hasTestResultsColumn = false;
    try {
      const columnCheck = await client.query(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = 'contest_submission_answers' AND column_name = 'test_results'
      `);
      hasTestResultsColumn = columnCheck.rowCount > 0;
      console.log("test_results column exists:", hasTestResultsColumn);
    } catch (err) {
      console.warn("Could not check for test_results column:", err.message);
      hasTestResultsColumn = false;
    }

    let totalMarks = 0;
    let obtainedMarks = 0;

    for (const q of qRes.rows) {

      totalMarks += q.marks || 0;
      const studentAnswer = answers[q.question_id];

      if (q.question_type === "mcq") {

        if (!studentAnswer) continue;

        const correct = await client.query(
          `
          SELECT 1
          FROM contest_options
          WHERE option_id = $1
            AND question_id = $2
            AND is_correct = true
          `,
          [studentAnswer, q.question_id]
        );

        const marks = correct.rowCount ? (q.marks || 0) : 0;
        obtainedMarks += marks;

        await client.query(
          `
          INSERT INTO contest_submission_answers
          (submission_id, question_id, option_id, marks_obtained)
          VALUES ($1,$2,$3,$4)
          `,
          [submissionId, q.question_id, studentAnswer, marks]
        );
      }

      else if (q.question_type === "descriptive") {

        const answerText = String(studentAnswer || "").toLowerCase();
        let marks = 0;

        const keywords = Array.isArray(q.keywords)
          ? q.keywords
          : (q.keywords || []);

        if (keywords.length && answerText) {
          let matched = 0;
          for (const k of keywords) {
            if (answerText.includes(String(k).toLowerCase())) matched++;
          }

          marks = Math.round(
            (matched / keywords.length) * (q.marks || 0)
          );
        }

        obtainedMarks += marks;

        await client.query(
          `
          INSERT INTO contest_submission_answers
          (submission_id, question_id, descriptive_answer, marks_obtained)
          VALUES ($1,$2,$3,$4)
          `,
          [submissionId, q.question_id, studentAnswer || null, marks]
        );
      }

      else if (q.question_type === "coding") {

        // For coding questions: check if student ran this code
        let marks = 0;
        let testResults = null;

        // Get the coding question language
        let language = q.language || "python";

        // Check if student has a recent test run for this question
        // Use pool directly (not client transaction) to avoid aborting transaction on error
        if (studentAnswer && studentId) {
          try {
            const latestRun = await pool.query(
              `
              SELECT marks_obtained, test_results
              FROM contest_test_runs
              WHERE student_id = $1 AND question_id = $2
              ORDER BY created_at DESC
              LIMIT 1
              `,
              [studentId, q.question_id]
            );

            if (latestRun.rowCount > 0) {
              // Use the marks from the most recent test run
              marks = latestRun.rows[0].marks_obtained || 0;
              testResults = latestRun.rows[0].test_results;
              console.log(`Using stored test run marks: ${marks} for question ${q.question_id}`);
            }
          } catch (runErr) {
            console.warn("Warning: Could not retrieve test runs:", runErr.message);
            // Fall through - marks stay at 0, will use async grading
          }
        }

        // Insert answer - conditionally include test_results if column exists
        if (hasTestResultsColumn && testResults) {
          await client.query(
            `
            INSERT INTO contest_submission_answers
            (submission_id, question_id, descriptive_answer, marks_obtained, test_results)
            VALUES ($1,$2,$3,$4,$5)
            `,
            [submissionId, q.question_id, studentAnswer || null, marks, JSON.stringify(testResults)]
          );
        } else {
          await client.query(
            `
            INSERT INTO contest_submission_answers
            (submission_id, question_id, descriptive_answer, marks_obtained)
            VALUES ($1,$2,$3,$4)
            `,
            [submissionId, q.question_id, studentAnswer || null, marks]
          );
        }

        obtainedMarks += marks;

        // If no test run found, queue async grading as fallback
        if (studentAnswer && marks === 0) {
          setImmediate(() => {
            gradeCodeAsync(submissionId, q.question_id, studentAnswer, language)
              .catch(err => console.error("Background grading error:", err.message));
          });
        }
      }
    }

    await client.query(
      `
      UPDATE contest_submissions
      SET total_marks = $1,
          obtained_marks = $2
      WHERE submission_id = $3
      `,
      [totalMarks, obtainedMarks, submissionId]
    );

    await client.query("COMMIT");

    res.json({
      message: "Contest submitted",
      totalMarks,
      obtainedMarks
    });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("submitContestAnswers error:", err.message);
    res.status(500).json({ message: err.message });
  } finally {
    client.release();
  }
};

/* =====================================================
   Student → coding question meta
===================================================== */
export const getCodingQuestionMetaForStudent = async (req, res) => {
  try {
    const { questionId } = req.params;

    const codingRes = await pool.query(
      `
      SELECT
        cq.coding_id,
        cq.title,
        cq.description,
        cq.language,
        cq.starter_code
      FROM contest_coding_questions cq
      WHERE cq.question_id = $1
      `,
      [questionId]
    );

    if (!codingRes.rowCount) {
      return res.status(404).json({ message: "Coding question not found" });
    }

    const coding = codingRes.rows[0];

    const tcRes = await pool.query(
      `
      SELECT input, expected_output, is_hidden
      FROM contest_test_cases
      WHERE coding_id = $1
      ORDER BY created_at
      `,
      [coding.coding_id]
    );

    res.json({
      title: coding.title,
      description: coding.description,
      language: coding.language,
      starterCode: coding.starter_code,
      testcases: tcRes.rows
    });
  } catch (err) {
    console.error("getCodingQuestionMetaForStudent error:", err);
    res.status(500).json({ message: "Failed to load coding meta" });
  }
};

/* ============================================
   Student → View result
============================================ */
export const getMyContestResult = async (req, res) => {
  try {
    const studentId = req.user.id;
    const { contestId } = req.params;

    const subRes = await pool.query(
      `
      SELECT submission_id
      FROM contest_submissions
      WHERE contest_id = $1
        AND student_id = $2
      `,
      [contestId, studentId]
    );

    if (!subRes.rowCount) {
      return res.status(404).json({ message: "Result not found" });
    }

    const submissionId = subRes.rows[0].submission_id;

    const ansRes = await pool.query(
      `
      SELECT
        q.question_text,
        q.question_type,
        q.marks AS max_marks,
        a.marks_obtained
      FROM contest_submission_answers a
      JOIN contest_questions q
        ON q.question_id = a.question_id
      WHERE a.submission_id = $1
      ORDER BY q.created_at
      `,
      [submissionId]
    );

    const submissionData = await pool.query(
      `SELECT total_marks, obtained_marks 
       FROM contest_submissions 
       WHERE submission_id = $1`,
      [submissionId]
    );
    const totalMarks = submissionData.rows[0].total_marks || 0;
    const obtainedMarks = submissionData.rows[0].obtained_marks || 0;

    res.json({
      contestId,
      submissionId,
      totalMarks,
      obtainedMarks,
      questions: ansRes.rows
    });

  } catch (err) {
    console.error("getMyContestResult error:", err.message);
    res.status(500).json({ message: "Failed to load result" });
  }
};

/* ============================================
   Contest leaderboard
============================================ */
export const getContestLeaderboard = async (req, res) => {
  try {
    const { contestId } = req.params;

    const result = await pool.query(
      `
      SELECT
        s.student_id,
        SUM(a.marks_obtained) AS total_marks,
        MIN(s.submitted_at)  AS submitted_at
      FROM contest_submissions s
      JOIN contest_submission_answers a
        ON a.submission_id = s.submission_id
      WHERE s.contest_id = $1
      GROUP BY s.student_id
      ORDER BY total_marks DESC, submitted_at ASC
      `,
      [contestId]
    );

    res.json(result.rows);

  } catch (err) {
    console.error("getContestLeaderboard error:", err.message);
    res.status(500).json({ message: "Failed to load leaderboard" });
  }
};