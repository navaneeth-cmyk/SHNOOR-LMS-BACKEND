import pool from "../db/postgres.js";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";

/* =====================================================
 helper
===================================================== */
const runSingleTest = (cmd, args, input, options = {}) => {
  return new Promise((resolve) => {

    const child = spawn(cmd, args, options);

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", d => stdout += d.toString());
    child.stderr.on("data", d => stderr += d.toString());

    if (input !== undefined && input !== null) {
      child.stdin.write(input);
    }
    child.stdin.end();

    child.on("close", () => {
      resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim()
      });
    });
  });
};

/**
 * Helper function to run code against test cases and calculate marks
 * @param {string} code - The code to run
 * @param {string} language - The programming language (python, java, javascript, c, cpp)
 * @param {array} testCases - Array of test case objects with input and expected_output
 * @param {int} questionMarks - Total marks for the question
 * @returns {object} - { testResults, passedCount, marksObtained }
 */
export const runCodeWithTestCases = async (code, language, testCases, questionMarks) => {
  let workDir = null;

  try {
    const baseTmp = path.join(process.cwd(), "tmp");
    if (!fs.existsSync(baseTmp)) fs.mkdirSync(baseTmp);

    workDir = path.join(baseTmp, `contest_${Date.now()}_${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(workDir);

    const testResults = [];
    let passedCount = 0;

    const checkOutput = async (runFn) => {
      for (let i = 0; i < testCases.length; i++) {
        const tc = testCases[i];
        const result = await runFn(tc.input ?? "");

        const expected = String(tc.expected_output ?? "").trim();
        const ok = result.stderr === "" && result.stdout === expected;

        if (ok) passedCount++;

        testResults.push({
          testCaseNumber: i + 1,
          passed: ok,
          isHidden: tc.is_hidden === true,
          input: tc.is_hidden ? undefined : tc.input,
          expectedOutput: tc.is_hidden ? undefined : expected,
          actualOutput: tc.is_hidden ? undefined : result.stdout,
          error: result.stderr || null
        });
      }
    };

    language = language.toLowerCase();

    /* ---------- PYTHON ---------- */
    if (language === "python") {
      fs.writeFileSync(path.join(workDir, "main.py"), code);
      await checkOutput((input) =>
        runSingleTest("python", ["main.py"], input, { cwd: workDir })
      );
    }
    /* ---------- JAVA ---------- */
    else if (language === "java") {
      fs.writeFileSync(path.join(workDir, "Main.java"), code);
      const compile = await runSingleTest("javac", ["Main.java"], null, { cwd: workDir });
      if (compile.stderr) {
        testResults.push({ testCaseNumber: 0, passed: false, error: compile.stderr });
        return { testResults, passedCount: 0, marksObtained: 0 };
      }
      await checkOutput((input) =>
        runSingleTest("java", ["Main"], input, { cwd: workDir })
      );
    }
    /* ---------- JAVASCRIPT ---------- */
    else if (language === "javascript" || language === "js") {
      fs.writeFileSync(path.join(workDir, "main.js"), code);
      await checkOutput((input) =>
        runSingleTest("node", ["main.js"], input, { cwd: workDir })
      );
    }
    /* ---------- C ---------- */
    else if (language === "c") {
      fs.writeFileSync(path.join(workDir, "main.c"), code);
      const compile = await runSingleTest("gcc", ["main.c", "-o", "main"], null, { cwd: workDir });
      if (compile.stderr) {
        testResults.push({ testCaseNumber: 0, passed: false, error: compile.stderr });
        return { testResults, passedCount: 0, marksObtained: 0 };
      }
      await checkOutput((input) =>
        runSingleTest(process.platform === "win32" ? "main.exe" : "./main", [], input, { cwd: workDir })
      );
    }
    /* ---------- C++ ---------- */
    else if (language === "cpp" || language === "c++") {
      fs.writeFileSync(path.join(workDir, "main.cpp"), code);
      const compile = await runSingleTest("g++", ["main.cpp", "-o", "main"], null, { cwd: workDir });
      if (compile.stderr) {
        testResults.push({ testCaseNumber: 0, passed: false, error: compile.stderr });
        return { testResults, passedCount: 0, marksObtained: 0 };
      }
      await checkOutput((input) =>
        runSingleTest(process.platform === "win32" ? "main.exe" : "./main", [], input, { cwd: workDir })
      );
    } else {
      throw new Error("Unsupported language");
    }

    // Calculate marks obtained based on test cases passed
    const marksObtained = testCases.length > 0 
      ? Math.round((passedCount / testCases.length) * questionMarks)
      : 0;

    return { testResults, passedCount, marksObtained };

  } finally {
    try {
      if (workDir && fs.existsSync(workDir)) {
        fs.rmSync(workDir, { recursive: true, force: true });
      }
    } catch {}
  }
};



/* =====================================================
 Instructor → Add descriptive contest question
===================================================== */
export const addDescriptiveContestQuestion = async (req, res) => {
  try {

    const { contestId } = req.params;
    const instructorId = req.user.id;
    const { questionText, marks = 1, keywords = [] } = req.body;

    if (!questionText) {
      return res.status(400).json({ message: "questionText required" });
    }

    const check = await pool.query(
      `
      SELECT exam_id
      FROM exams
      WHERE exam_id = $1
        AND instructor_id = $2
        AND exam_type = 'contest'
      `,
      [contestId, instructorId]
    );

    if (!check.rowCount) {
      return res.status(403).json({ message: "Access denied" });
    }

    const qRes = await pool.query(
      `
      INSERT INTO contest_questions
        (exam_id, question_text, question_type, marks, keywords)
      VALUES
        ($1,$2,'descriptive',$3,$4)
      RETURNING question_id
      `,
      [contestId, questionText, marks, JSON.stringify(keywords)]
    );

    res.status(201).json({
      message: "Descriptive question added",
      questionId: qRes.rows[0].question_id
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to add descriptive question" });
  }
};



/* =====================================================
 Instructor → Add coding contest question
===================================================== */
export const addCodingContestQuestion = async (req, res) => {

  const client = await pool.connect();

  try {

    const { contestId } = req.params;
    const instructorId = req.user.id;

    const {
      title,
      description,
      language,
      starterCode,
      marks = 1,
      testCases = []
    } = req.body;

    if (!title || !language) {
      return res.status(400).json({ message: "title and language required" });
    }

    const check = await client.query(
      `
      SELECT exam_id
      FROM exams
      WHERE exam_id = $1
        AND instructor_id = $2
        AND exam_type = 'contest'
      `,
      [contestId, instructorId]
    );

    if (!check.rowCount) {
      return res.status(403).json({ message: "Access denied" });
    }

    await client.query("BEGIN");

    const qRes = await client.query(
      `
      INSERT INTO contest_questions
        (exam_id, question_text, question_type, marks)
      VALUES
        ($1,$2,'coding',$3)
      RETURNING question_id
      `,
      [contestId, title, marks]
    );

    const questionId = qRes.rows[0].question_id;

    const codingRes = await client.query(
      `
      INSERT INTO contest_coding_questions
        (question_id, title, description, language, starter_code)
      VALUES
        ($1,$2,$3,$4,$5)
      RETURNING coding_id
      `,
      [questionId, title, description || "", language, starterCode || ""]
    );

    const codingId = codingRes.rows[0].coding_id;

    for (const tc of testCases) {
      await client.query(
        `
        INSERT INTO contest_test_cases
          (coding_id, input, expected_output, is_hidden)
        VALUES
          ($1,$2,$3,$4)
        `,
        [
          codingId,
          tc.input || "",
          tc.expected_output || "",
          tc.is_hidden === true
        ]
      );
    }

    await client.query("COMMIT");

    res.status(201).json({ message: "Coding question added", questionId });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ message: "Failed to add coding question" });
  } finally {
    client.release();
  }
};



/* =====================================================
 Student → Run code
===================================================== */
export const runContestQuestionCode = async (req, res) => {
  try {

    const { contestId, questionId } = req.params;
    const studentId = req.user?.id;
    let { code, language } = req.body;

    if (!code || !language) {
      return res.status(400).json({ message: "code and language required" });
    }

    if (!studentId) {
      return res.status(401).json({ message: "Not authenticated" });
    }

    // Get question marks
    const qRes = await pool.query(
      `
      SELECT marks
      FROM contest_questions
      WHERE question_id = $1
      `,
      [questionId]
    );

    if (!qRes.rowCount) {
      return res.status(404).json({ message: "Question not found" });
    }

    const questionMarks = qRes.rows[0].marks || 1;

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

    if (!tcRes.rowCount) {
      return res.status(404).json({ message: "No test cases found" });
    }

    // Run code against test cases
    const { testResults, passedCount, marksObtained } = await runCodeWithTestCases(
      code,
      language,
      tcRes.rows,
      questionMarks
    );

    // Store this test run for later retrieval during submission
    // Wrapped in try-catch since table might not exist in older databases
    try {
      await pool.query(
        `
        INSERT INTO contest_test_runs
        (student_id, question_id, code, language, test_results, marks_obtained, passed_count, total_tests)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        `,
        [
          studentId,
          questionId,
          code,
          language,
          JSON.stringify(testResults),
          marksObtained,
          passedCount,
          tcRes.rowCount
        ]
      );
    } catch (storeErr) {
      console.warn("Warning: Could not store test run (table might not exist):", storeErr.message);
      // Continue anyway - this is not critical
    }

    res.json({
      testResults,
      summary: {
        total: testResults.length,
        passed: passedCount,
        failed: testResults.length - passedCount
      },
      passed: passedCount === testResults.length,
      marks: {
        total: questionMarks,
        obtained: marksObtained
      }
    });

  } catch (err) {

    console.error("runContestQuestionCode error:", err);

    res.status(500).json({
      message: "Failed to run code",
      error: err.message
    });

  }
};