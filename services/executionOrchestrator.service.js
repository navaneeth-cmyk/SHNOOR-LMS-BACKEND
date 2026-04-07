import { exec } from "child_process";
import util from "util";

const execAsync = util.promisify(exec);

class ExecutionOrchestrator {

  async evaluateWithTestCases(code, language, testCases) {

    const results = [];

    for (const tc of testCases) {

      try {
        const { stdout, stderr } =
          await this.runInsideContainer(code, language, tc.input || "");

        const actual = (stdout || "").trim();
        const expected = (tc.expected_output || "").trim();

        results.push({
          input: tc.input,
          expectedOutput: expected,
          actualOutput: actual,
          passed: actual === expected,
          isHidden: tc.is_hidden,
          error: stderr || null
        });

      } catch (err) {
        results.push({
          input: tc.input,
          expectedOutput: tc.expected_output,
          actualOutput: "",
          passed: false,
          isHidden: tc.is_hidden,
          error: err.message
        });
      }
    }

    const passed = results.filter(r => r.passed).length;

    return {
      passed: passed === results.length,
      testResults: results,
      summary: {
        total: results.length,
        passed,
        failed: results.length - passed
      }
    };
  }

  async runInsideContainer(code, language, input) {

    let cmd;

    const escapedCode = code.replace(/"/g, '\\"');
    const escapedInput = (input || "").replace(/"/g, '\\"');

    switch (language.toLowerCase()) {

      case "python":
        cmd = `
docker exec shnoor-runner sh -c "
printf \\"%s\\" \\"${escapedCode}\\" > /sandbox/main.py &&
printf \\"%s\\" \\"${escapedInput}\\" | python3 /sandbox/main.py
"
`;
        break;

      case "javascript":
      case "js":
        cmd = `
docker exec shnoor-runner sh -c "
printf \\"%s\\" \\"${escapedCode}\\" > /sandbox/main.js &&
printf \\"%s\\" \\"${escapedInput}\\" | node /sandbox/main.js
"
`;
        break;

      case "cpp":
      case "c++":
        cmd = `
docker exec shnoor-runner sh -c "
printf \\"%s\\" \\"${escapedCode}\\" > /sandbox/main.cpp &&
g++ /sandbox/main.cpp -o /sandbox/a.out &&
printf \\"%s\\" \\"${escapedInput}\\" | /sandbox/a.out
"
`;
        break;

      case "java":
        cmd = `
docker exec shnoor-runner sh -c "
printf \\"%s\\" \\"${escapedCode}\\" > /sandbox/Main.java &&
javac /sandbox/Main.java &&
printf \\"%s\\" \\"${escapedInput}\\" | java -cp /sandbox Main
"
`;
        break;

      default:
        throw new Error("Language not supported: " + language);
    }

    return execAsync(cmd);
  }

}

export default new ExecutionOrchestrator();