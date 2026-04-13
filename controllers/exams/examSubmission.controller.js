import pool from "../../db/postgres.js";
import { issueExamCertificate } from "../certificate.controller.js";
import { autoGradeDescriptive } from "./examdescriptive.controller.js";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { buildJavaScriptRuntimeSource } from "../../utils/javascriptExecution.js";
import { compareExecutionOutput } from "../../utils/executionOutput.js";

const runSingleTest = (cmd, args, input, options = {}, timeoutMs = 5000) => {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, options);
    } catch (error) {
      resolve({ stdout: "", stderr: error.message || "Failed to start process" });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;

    const done = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };

    const timeout = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch (_) {
        // ignore
      }
      done({
        stdout: stdout.trim(),
        stderr: `Execution timed out after ${timeoutMs / 1000} seconds`,
      });
    }, timeoutMs);

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));

    if (input !== undefined && input !== null) {
      child.stdin.write(input);
    }
    child.stdin.end();

    child.on("error", (err) => {
      clearTimeout(timeout);
      done({ stdout: "", stderr: err?.message || `Runtime command not found: ${cmd}` });
    });

    child.on("close", () => {
      clearTimeout(timeout);
      done({ stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
};

const normalizeOutput = (value) =>
  String(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();

const normalizeToken = (token) => {
  const raw = String(token ?? "").trim();
  if (raw === "") return "";

  const lower = raw.toLowerCase();
  if (lower === "true") return "true";
  if (lower === "false") return "false";

  if (/^[+-]?\d+(\.\d+)?$/.test(raw)) {
    const asNumber = Number(raw);
    if (Number.isFinite(asNumber)) return String(asNumber);
  }

  return raw;
};

const compareOutputs = (expectedRaw, actualRaw) => {
  return compareExecutionOutput(expectedRaw, actualRaw).passed;
};

const isDockerUnavailableError = (stderr) =>
  /not recognized|enoent|command not found|cannot find/i.test(String(stderr || ""));

const runDockerCommand = async (workDir, image, command, input = "", timeoutMs = 5000) => {
  const mountPath = path.resolve(workDir);

  return runSingleTest(
    "docker",
    [
      "run",
      "--rm",
      "-i",
      "--network",
      "none",
      "--memory",
      "256m",
      "--cpus",
      "1",
      "-e",
      "PYTHONDONTWRITEBYTECODE=1",
      "-v",
      `${mountPath}:/code`,
      "-w",
      "/code",
      image,
      "sh",
      "-lc",
      command,
    ],
    input,
    { cwd: workDir },
    timeoutMs
  );
};

const runWithFallbackCommands = async (candidates, args, input, options = {}, timeoutMs = 5000) => {
  let lastError = "";

  for (const cmd of candidates) {
    const result = await runSingleTest(cmd, args, input, options, timeoutMs);
    if (isDockerUnavailableError(result.stderr)) {
      lastError = String(result.stderr || "");
      continue;
    }
    return result;
  }

  return {
    stdout: "",
    stderr: lastError || `Runtime unavailable: ${candidates.join(", ")}`,
  };
};

const prepareLanguageRunner = async (workDir, language, code, timeoutMs = 5000) => {
  const normalizedLanguage = (language || "").toLowerCase();

  if (normalizedLanguage === "python") {
    fs.writeFileSync(path.join(workDir, "main.py"), code);
    return {
      runFn: async (input) => {
        const dockerResult = await runDockerCommand(workDir, "python:3.11-alpine", "python /code/main.py", input, timeoutMs);
        if (!isDockerUnavailableError(dockerResult.stderr)) return dockerResult;
        return runWithFallbackCommands(["python3", "python", "py"], ["main.py"], input, { cwd: workDir }, timeoutMs);
      },
    };
  }

  if (normalizedLanguage === "javascript" || normalizedLanguage === "js") {
    return {
      runFn: async (input) => {
        fs.writeFileSync(path.join(workDir, "main.js"), buildJavaScriptRuntimeSource(code, input));
        const dockerResult = await runDockerCommand(workDir, "node:20-alpine", "node /code/main.js", input, timeoutMs);
        if (!isDockerUnavailableError(dockerResult.stderr)) return dockerResult;
        return runWithFallbackCommands(["node"], ["main.js"], input, { cwd: workDir }, timeoutMs);
      },
    };
  }

  if (normalizedLanguage === "java") {
    fs.writeFileSync(path.join(workDir, "Main.java"), code);

    const dockerCompile = await runDockerCommand(workDir, "eclipse-temurin:17-jdk-alpine", "javac /code/Main.java", "", timeoutMs);
    if (!isDockerUnavailableError(dockerCompile.stderr)) {
      if (dockerCompile.stderr) return { compileError: dockerCompile.stderr };
      return {
        runFn: (input) => runDockerCommand(workDir, "eclipse-temurin:17-jdk-alpine", "java -cp /code Main", input, timeoutMs),
      };
    }

    const localCompile = await runSingleTest("javac", ["Main.java"], null, { cwd: workDir }, timeoutMs);
    if (localCompile.stderr) return { compileError: localCompile.stderr };
    return {
      runFn: (input) => runSingleTest("java", ["Main"], input, { cwd: workDir }, timeoutMs),
    };
  }

  if (normalizedLanguage === "c") {
    fs.writeFileSync(path.join(workDir, "main.c"), code);

    const dockerCompile = await runDockerCommand(workDir, "gcc:13", "gcc /code/main.c -O2 -o /code/main", "", timeoutMs);
    if (!isDockerUnavailableError(dockerCompile.stderr)) {
      if (dockerCompile.stderr) return { compileError: dockerCompile.stderr };
      return {
        runFn: (input) => runDockerCommand(workDir, "gcc:13", "/code/main", input, timeoutMs),
      };
    }

    const localCompile = await runSingleTest("gcc", ["main.c", "-O2", "-o", "main"], null, { cwd: workDir }, timeoutMs);
    if (localCompile.stderr) return { compileError: localCompile.stderr };
    return {
      runFn: (input) => runSingleTest(process.platform === "win32" ? "main.exe" : "./main", [], input, { cwd: workDir }, timeoutMs),
    };
  }

  if (normalizedLanguage === "cpp" || normalizedLanguage === "c++") {
    fs.writeFileSync(path.join(workDir, "main.cpp"), code);

    const dockerCompile = await runDockerCommand(workDir, "gcc:13", "g++ /code/main.cpp -std=c++17 -O2 -o /code/main", "", timeoutMs);
    if (!isDockerUnavailableError(dockerCompile.stderr)) {
      if (dockerCompile.stderr) return { compileError: dockerCompile.stderr };
      return {
        runFn: (input) => runDockerCommand(workDir, "gcc:13", "/code/main", input, timeoutMs),
      };
    }

    const localCompile = await runSingleTest("g++", ["main.cpp", "-std=c++17", "-O2", "-o", "main"], null, { cwd: workDir }, timeoutMs);
    if (localCompile.stderr) return { compileError: localCompile.stderr };
    return {
      runFn: (input) => runSingleTest(process.platform === "win32" ? "main.exe" : "./main", [], input, { cwd: workDir }, timeoutMs),
    };
  }

  if (normalizedLanguage === "go") {
    fs.writeFileSync(path.join(workDir, "main.go"), code);
    return {
      runFn: async (input) => {
        const dockerResult = await runDockerCommand(workDir, "golang:1.22-alpine", "go run /code/main.go", input, timeoutMs);
        if (!isDockerUnavailableError(dockerResult.stderr)) return dockerResult;
        return runSingleTest("go", ["run", "main.go"], input, { cwd: workDir }, timeoutMs);
      },
    };
  }

  return { unsupported: true };
};

const upsertSubmittedAnswers = async (client, examId, studentId, answers = {}) => {
  const answerEntries = Object.entries(answers || {});
  if (!answerEntries.length) return;

  const { rows: examQuestions } = await client.query(
    `
    SELECT question_id, question_type, marks
    FROM exam_questions
    WHERE exam_id = $1
    `,
    [examId]
  );

  const questionMap = new Map(
    examQuestions.map((q) => [String(q.question_id), q])
  );

  for (const [questionIdRaw, submittedValue] of answerEntries) {
    const question = questionMap.get(String(questionIdRaw));
    if (!question) continue;

    const questionId = question.question_id;
    const questionType = String(question.question_type || "").toLowerCase();

    if (questionType === "mcq") {
      const selectedOptionId = submittedValue ? String(submittedValue) : null;
      if (!selectedOptionId) continue;

      const { rows: optionRows } = await client.query(
        `
        SELECT is_correct
        FROM exam_mcq_options
        WHERE option_id = $1
          AND question_id = $2
        LIMIT 1
        `,
        [selectedOptionId, questionId]
      );

      if (!optionRows.length) continue;

      const marksObtained = optionRows[0].is_correct ? Number(question.marks || 0) : 0;

      await client.query(
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
      continue;
    }

    // Descriptive + coding answers are stored as text and graded downstream.
    if (questionType === "descriptive" || questionType === "coding") {
      const answerText =
        typeof submittedValue === "string"
          ? submittedValue
          : submittedValue == null
            ? ""
            : String(submittedValue);

      await client.query(
        `
        INSERT INTO exam_answers
          (exam_id, question_id, student_id, selected_option_id, answer_text, marks_obtained)
        VALUES ($1, $2, $3, NULL, $4, 0)
        ON CONFLICT ON CONSTRAINT unique_answer_per_question
        DO UPDATE SET
          selected_option_id = NULL,
          answer_text = EXCLUDED.answer_text
        `,
        [examId, questionId, studentId, answerText]
      );
    }
  }
};

const computeAndPersistResult = async (client, examId, studentId) => {
  const { rows: questions } = await client.query(
    `
    SELECT question_id, marks, question_type
    FROM exam_questions
    WHERE exam_id = $1
    `,
    [examId]
  );

  let totalMarks = 0;
  questions.forEach((q) => {
    totalMarks += Number(q.marks || 0);
  });

  const { rows: savedAnswers } = await client.query(
    `
    SELECT 
      ea.question_id,
      ea.selected_option_id,
      ea.answer_text,
      ea.marks_obtained,
      eq.question_type,
      eq.marks,
      eo.is_correct,
      eo.option_id
    FROM exam_answers ea
    JOIN exam_questions eq 
      ON ea.question_id = eq.question_id
    LEFT JOIN exam_mcq_options eo
      ON ea.selected_option_id = eo.option_id
    WHERE ea.exam_id = $1
    AND ea.student_id = $2
    `,
    [examId, studentId]
  );

  let obtainedMarks = 0;

  // MCQ uses is_correct join; descriptive/coding are handled in later passes.
  savedAnswers.forEach((answer) => {
    if (answer.question_type === "mcq" && answer.is_correct) {
      obtainedMarks += Number(answer.marks || 0);
    }
    if (answer.question_type === "descriptive") {
      obtainedMarks += Number(answer.marks_obtained || 0);
    }
    if (answer.question_type === "coding") {
      obtainedMarks += Number(answer.marks_obtained || 0);
    }
  });

  // Auto-grade descriptive answers.
  for (const answer of savedAnswers) {
    if (answer.question_type !== "descriptive" || !answer.answer_text) continue;

    const { rows: questionDetails } = await client.query(
      `
      SELECT keywords, min_word_count, marks
      FROM exam_questions
      WHERE question_id = $1
      `,
      [answer.question_id]
    );

    if (!questionDetails.length) continue;

    const q = questionDetails[0];
    const calculatedMarks = autoGradeDescriptive(
      answer.answer_text,
      q.keywords,
      q.min_word_count || 30,
      q.marks
    );

    await client.query(
      `
      UPDATE exam_answers
      SET marks_obtained = $1
      WHERE exam_id = $2
      AND question_id = $3
      AND student_id = $4
      `,
      [calculatedMarks, examId, answer.question_id, studentId]
    );

    obtainedMarks -= Number(answer.marks_obtained || 0);
    obtainedMarks += Number(calculatedMarks || 0);
  }

  // Auto-grade coding answers against test cases.
  for (const answer of savedAnswers) {
    if (answer.question_type !== "coding" || !answer.answer_text) continue;

    const { rows: codingRows } = await client.query(
      `
      SELECT cq.coding_id, cq.language, q.marks
      FROM exam_coding_questions cq
      JOIN exam_questions q ON q.question_id = cq.question_id
      WHERE cq.question_id = $1
      `,
      [answer.question_id]
    );

    if (!codingRows.length) {
      await client.query(
        `
        UPDATE exam_answers
        SET marks_obtained = 0
        WHERE exam_id = $1 AND question_id = $2 AND student_id = $3
        `,
        [examId, answer.question_id, studentId]
      );
      obtainedMarks -= Number(answer.marks_obtained || 0);
      continue;
    }

    const coding = codingRows[0];
    const maxMarks = Number(coding.marks || 0);

    const { rows: testCases } = await client.query(
      `
      SELECT input, expected_output
      FROM exam_test_cases
      WHERE coding_id = $1
      ORDER BY test_id ASC
      `,
      [coding.coding_id]
    );

    if (!testCases.length) {
      await client.query(
        `
        UPDATE exam_answers
        SET marks_obtained = 0
        WHERE exam_id = $1 AND question_id = $2 AND student_id = $3
        `,
        [examId, answer.question_id, studentId]
      );
      obtainedMarks -= Number(answer.marks_obtained || 0);
      continue;
    }

    const baseTmp = path.join(process.cwd(), "tmp");
    if (!fs.existsSync(baseTmp)) fs.mkdirSync(baseTmp);
    const workDir = path.join(baseTmp, `exam_${Date.now()}_${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(workDir);

    let calculatedMarks = 0;
    try {
      const prepared = await prepareLanguageRunner(workDir, coding.language, answer.answer_text, 5000);

      if (prepared.unsupported || prepared.compileError) {
        calculatedMarks = 0;
      } else {
        let passedCount = 0;
        for (const tc of testCases) {
          const runResult = await prepared.runFn(tc.input ?? "");
          const passed =
            runResult.stderr === "" &&
            compareOutputs(tc.expected_output ?? "", runResult.stdout ?? "");
          if (passed) passedCount += 1;
        }

        calculatedMarks = testCases.length > 0 ? (maxMarks * passedCount) / testCases.length : 0;
      }
    } finally {
      try {
        if (fs.existsSync(workDir)) {
          fs.rmSync(workDir, { recursive: true, force: true });
        }
      } catch (_) {
        // ignore cleanup errors
      }
    }

    await client.query(
      `
      UPDATE exam_answers
      SET marks_obtained = $1
      WHERE exam_id = $2
      AND question_id = $3
      AND student_id = $4
      `,
      [calculatedMarks, examId, answer.question_id, studentId]
    );

    obtainedMarks -= Number(answer.marks_obtained || 0);
    obtainedMarks += Number(calculatedMarks || 0);
  }

  const percentage =
    totalMarks === 0 ? 0 : Number(((obtainedMarks / totalMarks) * 100).toFixed(2));

  const { rows: exam } = await client.query(
    `
    SELECT pass_percentage
    FROM exams
    WHERE exam_id = $1
    `,
    [examId]
  );

  if (!exam.length) {
    throw new Error("Exam not found");
  }

  const passPercentage = Number(exam[0].pass_percentage || 0);
  const passed = percentage >= passPercentage;

  await client.query(
    `
    INSERT INTO exam_results
      (exam_id, student_id, total_marks, obtained_marks, percentage, passed, evaluated_at)
    VALUES ($1, $2, $3, $4, $5, $6, NOW())
    ON CONFLICT (exam_id, student_id)
    DO UPDATE SET
      total_marks = EXCLUDED.total_marks,
      obtained_marks = EXCLUDED.obtained_marks,
      percentage = EXCLUDED.percentage,
      passed = EXCLUDED.passed,
      evaluated_at = NOW()
    `,
    [examId, studentId, totalMarks, obtainedMarks, percentage, passed]
  );

  await client.query(
    `
    UPDATE exam_attempts
    SET status = 'submitted',
        submitted_at = NOW(),
        disconnected_at = NULL
    WHERE exam_id = $1
    AND student_id = $2
    `,
    [examId, studentId]
  );

  if (passed) {
    await client.query(
      `
      UPDATE users
      SET xp = COALESCE(xp, 0) + 100
      WHERE user_id = $1
      `,
      [studentId]
    );
  }

  return {
    totalMarks,
    obtainedMarks,
    percentage,
    passed,
  };
};

const issueCertificateIfEligible = async (examId, studentId, percentage, passed) => {
  let certificateIssued = false;

  if (!passed) {
    return certificateIssued;
  }

  try {
    const certResult = await issueExamCertificate({
      userId: studentId,
      examId,
      score: percentage,
    });

    certificateIssued = certResult?.issued || false;
  } catch (certErr) {
    console.error("Certificate error:", certErr);
  }

  return certificateIssued;
};

export const submitExam = async (req, res) => {
  const client = await pool.connect();

  try {
    const studentId = req.user.id;
    const { answers = {} } = req.body || {};
    let { examId } = req.params;

    if (examId && examId.startsWith("final_")) {
      const courseId = examId.replace("final_", "");
      const { rows: resolvedExams } = await client.query(
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
        examId = resolvedExams[0].exam_id;
      } else {
        examId = courseId;
      }
    }

    const { rows: attemptRows } = await client.query(
      `
      SELECT ea.end_time, e.disconnect_grace_time
      FROM exam_attempts ea
      JOIN exams e ON e.exam_id = ea.exam_id
      WHERE ea.exam_id = $1 AND ea.student_id = $2
      `,
      [examId, studentId]
    );

    if (!attemptRows.length) {
      return res.status(400).json({ message: "Exam attempt not found" });
    }

    const endTime = attemptRows[0].end_time;
    const graceSeconds = attemptRows[0].disconnect_grace_time || 0;
    const { rows: nowRows } = await client.query("SELECT NOW() AS now");
    const now = nowRows[0].now;

    const deadlineMs = new Date(endTime).getTime() + graceSeconds * 1000;
    if (new Date(now).getTime() > deadlineMs) {
      return res.status(403).json({ message: "Submission window closed" });
    }

    if (!studentId) {
      return res.status(401).json({ message: "Unauthorized: student ID not found" });
    }

    await client.query("BEGIN");
    await upsertSubmittedAnswers(client, examId, studentId, answers);
    const result = await computeAndPersistResult(client, examId, studentId);
    await client.query("COMMIT");

    const certificateIssued = await issueCertificateIfEligible(
      examId,
      studentId,
      result.percentage,
      result.passed
    );

    if (global.io) {
      global.io.to(`user_${studentId}`).emit("dashboard_update", {
        type: "exam_submitted",
        examId,
        passed: result.passed,
      });
    }

    res.status(201).json({
      message: "Exam submitted successfully",
      totalMarks: result.totalMarks,
      obtainedMarks: result.obtainedMarks,
      percentage: result.percentage,
      passed: result.passed,
      certificateIssued,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Submit exam error:", err);

    res.status(500).json({
      message: "Failed to submit exam",
    });
  } finally {
    client.release();
  }
};

export const autoSubmitExam = async (studentId, examId) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      `
      SELECT status
      FROM exam_attempts
      WHERE exam_id = $1
      AND student_id = $2
      `,
      [examId, studentId]
    );

    if (!rows.length || rows[0].status === "submitted") {
      await client.query("ROLLBACK");
      return;
    }

    const result = await computeAndPersistResult(client, examId, studentId);
    await client.query("COMMIT");

    await issueCertificateIfEligible(examId, studentId, result.percentage, result.passed);

    if (global.io) {
      global.io.to(`user_${studentId}`).emit("dashboard_update", {
        type: "exam_auto_submitted",
        examId,
        passed: result.passed,
      });
    }

    console.log(`Auto-submitted exam ${examId} for student ${studentId}`);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Auto submit error:", err);
  } finally {
    client.release();
  }
};