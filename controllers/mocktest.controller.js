import { spawn, exec } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";

const execAsync = promisify(exec);

/* ─── Platform ────────────────────────────────────────────────────────────── */
const isWin = process.platform === "win32";

/* ─── Compiler directory & paths ─────────────────────────────────────────── */
// g++ is NOT in system PATH on this machine — it lives in msys64
// We inject the bin dir into the child process PATH so all tools resolve
const MINGW_BIN = "C:\\msys64\\mingw64\\bin";
const GPP_EXE   = isWin ? path.join(MINGW_BIN, "g++.exe")  : "g++";
const GCC_EXE   = isWin ? path.join(MINGW_BIN, "gcc.exe")  : "gcc";

// Build a child-process env that includes the mingw64 bin directory
const childEnv = isWin
  ? { ...process.env, PATH: `${MINGW_BIN};${process.env.PATH}` }
  : process.env;

console.log("Platform:", process.platform);
console.log("GPP_EXE:", GPP_EXE);
console.log("childEnv PATH prefix:", isWin ? MINGW_BIN : "(unchanged)");

/* ─── Verify g++ on startup ───────────────────────────────────────────────── */
try {
  const { execSync } = await import("child_process");
  const out = execSync(`"${GPP_EXE}" --version`, { env: childEnv });
  console.log("g++ check OK:", out.toString().split("\n")[0].trim());
} catch (e) {
  console.error("g++ check FAILED:", e.message);
}

/* ─── Detect python ───────────────────────────────────────────────────────── */
let PYTHON_CMD = null;
const detectPython = async () => {
  if (PYTHON_CMD) return PYTHON_CMD;
  for (const cmd of ["python3", "python"]) {
    try {
      await execAsync(`${cmd} --version`, { env: childEnv });
      PYTHON_CMD = cmd;
      return cmd;
    } catch { continue; }
  }
  throw new Error("Python is not installed on this server.");
};

/* ─── compileCode: uses exec with injected PATH + shell:true ──────────────── */
const compileCode = (command, cwd) => {
  return new Promise((resolve) => {
    console.log(`[compile] cmd: ${command}`);
    console.log(`[compile] cwd: ${cwd}`);

    exec(command, { cwd, shell: true, env: childEnv }, (err, stdout, stderr) => {
      console.log("[compile] raw err.code:", err?.code ?? "null");
      console.log("[compile] raw stdout:", stdout);
      console.log("[compile] raw stderr:", stderr);

      const exitCode = err ? (typeof err.code === "number" ? err.code : 1) : 0;
      // g++ may write errors to stderr OR stdout — merge both
      const combinedErr = [stderr, stdout]
        .map((s) => (s ?? "").trim())
        .filter(Boolean)
        .join("\n");

      resolve({ exitCode, stderr: combinedErr });
    });
  });
};

/* ─── runBinary: runs compiled .exe with stdin ────────────────────────────── */
const runBinary = (exePath, input, cwd, timeoutMs = 10000) => {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    console.log(`[runBinary] path: ${exePath}`);
    console.log(`[runBinary] input: ${JSON.stringify(input)}`);

    const child = isWin
      ? spawn(`"${exePath}"`, [], { cwd, shell: true, env: childEnv })
      : spawn(exePath, [], { cwd, shell: false, env: childEnv });

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { child.kill("SIGKILL"); } catch {}
        resolve({ stdout: "", stderr: "Time Limit Exceeded (10s)", exitCode: -1 });
      }
    }, timeoutMs);

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));

    if (input !== null && input !== undefined) {
      try { child.stdin.write(String(input)); } catch {}
    }
    try { child.stdin.end(); } catch {}

    child.on("close", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        console.log(`[runBinary] stdout: "${stdout.trim()}" stderr: "${stderr.trim()}" code: ${code}`);
        resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode: code });
      }
    });

    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        console.error(`[runBinary] spawn error: ${err.message}`);
        resolve({ stdout: "", stderr: err.message, exitCode: -1 });
      }
    });
  });
};

/* ─── runScript: runs interpreted languages with stdin ────────────────────── */
const runScript = (command, input, cwd, timeoutMs = 10000) => {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    console.log(`[runScript] cmd: ${command}`);

    const child = spawn(command, [], { cwd, shell: true, env: childEnv });

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { child.kill("SIGKILL"); } catch {}
        resolve({ stdout: "", stderr: "Time Limit Exceeded (10s)", exitCode: -1 });
      }
    }, timeoutMs);

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));

    if (input !== null && input !== undefined) {
      try { child.stdin.write(String(input)); } catch {}
    }
    try { child.stdin.end(); } catch {}

    child.on("close", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        console.log(`[runScript] stdout: "${stdout.trim()}" stderr: "${stderr.trim()}" code: ${code}`);
        resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode: code });
      }
    });

    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ stdout: "", stderr: err.message, exitCode: -1 });
      }
    });
  });
};

/* ─── Compilation error response ─────────────────────────────────────────── */
const compilationErrorResponse = (stderr) => ({
  testResults: [{
    testCaseNumber: 0,
    passed: false,
    error: `Compilation Error:\n${stderr || "Compiler returned non-zero exit but produced no output."}`,
    input: null,
    expectedOutput: null,
    actualOutput: null,
  }],
  summary: { total: 1, passed: 0, failed: 1 },
  passed: false,
});

/* ─── Normalize input: literal \n → real newline ──────────────────────────── */
const normalizeInput = (raw) =>
  String(raw ?? "")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\r/g, "\r");

/* ─── Evaluate all test cases ─────────────────────────────────────────────── */
const evaluateTests = async (testCases, runFn) => {
  const results = [];
  let passedCount = 0;

  for (let i = 0; i < testCases.length; i++) {
    const tc = testCases[i];
    const input = normalizeInput(tc.input);
    const result = await runFn(input);

    const expected = String(tc.output ?? "").trim();
    const actual   = (result.stdout ?? "").trim();
    const hasError = !!(result.stderr?.length);
    const ok       = !hasError && actual === expected;

    if (ok) passedCount++;

    results.push({
      testCaseNumber: i + 1,
      passed: ok,
      input: tc.input,
      expectedOutput: expected,
      actualOutput: actual,
      error: result.stderr || null,
    });
  }

  return { results, passedCount };
};

/* ─── Main controller ─────────────────────────────────────────────────────── */
export const runMockTestCode = async (req, res) => {
  let workDir = null;

  try {
    let { code, language, testCases } = req.body;

    if (!code || !language)
      return res.status(400).json({ message: "code and language required" });
    if (!Array.isArray(testCases) || testCases.length === 0)
      return res.status(400).json({ message: "testCases required" });

    language = language.toLowerCase().trim();
    if (language === "c++") language = "cpp";

    console.log(`\n══ runMockTestCode | lang=${language} | tests=${testCases.length} ══`);

    const baseTmp = path.join(process.cwd(), "tmp");
    if (!fs.existsSync(baseTmp)) fs.mkdirSync(baseTmp, { recursive: true });

    workDir = path.join(baseTmp, `run_${Date.now()}_${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(workDir, { recursive: true });

    let testResults = [];
    let passedCount = 0;

    /* ── PYTHON ── */
    if (language === "python") {
      const pythonCmd = await detectPython();
      fs.writeFileSync(path.join(workDir, "main.py"), code, "utf8");
      const { results, passedCount: pc } = await evaluateTests(testCases, (input) =>
        runScript(`${pythonCmd} main.py`, input, workDir)
      );
      testResults = results; passedCount = pc;
    }

    /* ── JAVASCRIPT ── */
    else if (language === "javascript" || language === "js") {
      fs.writeFileSync(path.join(workDir, "main.js"), code, "utf8");
      const { results, passedCount: pc } = await evaluateTests(testCases, (input) =>
        runScript("node main.js", input, workDir)
      );
      testResults = results; passedCount = pc;
    }

    /* ── JAVA ── */
    else if (language === "java") {
      fs.writeFileSync(path.join(workDir, "Main.java"), code, "utf8");
      const compile = await compileCode("javac Main.java", workDir);
      if (compile.exitCode !== 0) return res.json(compilationErrorResponse(compile.stderr));
      const { results, passedCount: pc } = await evaluateTests(testCases, (input) =>
        runScript("java Main", input, workDir)
      );
      testResults = results; passedCount = pc;
    }

    /* ── C ── */
    else if (language === "c") {
      fs.writeFileSync(path.join(workDir, "main.c"), code, "utf8");
      const outBin = isWin ? "main.exe" : "main";
      const compile = await compileCode(`"${GCC_EXE}" main.c -o ${outBin} -lm`, workDir);
      if (compile.exitCode !== 0) return res.json(compilationErrorResponse(compile.stderr));
      const exePath = path.join(workDir, outBin);
      console.log("C binary exists:", fs.existsSync(exePath));
      const { results, passedCount: pc } = await evaluateTests(testCases, (input) =>
        runBinary(exePath, input, workDir)
      );
      testResults = results; passedCount = pc;
    }

    /* ── C++ ── */
    else if (language === "cpp") {
      fs.writeFileSync(path.join(workDir, "main.cpp"), code, "utf8");
      console.log("C++ code length:", fs.readFileSync(path.join(workDir, "main.cpp"), "utf8").length);

      const outBin     = isWin ? "main.exe" : "main";
      const compileCmd = `"${GPP_EXE}" main.cpp -o ${outBin} -std=c++17`;

      const compile = await compileCode(compileCmd, workDir);
      if (compile.exitCode !== 0) return res.json(compilationErrorResponse(compile.stderr));

      const exePath = path.join(workDir, outBin);
      console.log("C++ binary exists:", fs.existsSync(exePath), "at:", exePath);

      if (!fs.existsSync(exePath))
        return res.json(compilationErrorResponse("Binary not found after compile. Check g++ path."));

      const { results, passedCount: pc } = await evaluateTests(testCases, (input) =>
        runBinary(exePath, input, workDir)
      );
      testResults = results; passedCount = pc;
    }

    else {
      return res.status(400).json({ message: `Unsupported language: ${language}` });
    }

    return res.json({
      testResults,
      summary: {
        total: testResults.length,
        passed: passedCount,
        failed: testResults.length - passedCount,
      },
      passed: passedCount === testResults.length,
    });

  } catch (err) {
    console.error("runMockTestCode error:", err);
    return res.status(500).json({ message: err.message || "Failed to run code", error: err.message });
  } finally {
    try {
      if (workDir && fs.existsSync(workDir))
        fs.rmSync(workDir, { recursive: true, force: true });
    } catch {}
  }
};