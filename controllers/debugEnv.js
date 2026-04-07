// Add this temporary debug route to check available compilers
// router.get("/debug", debugEnv);

import { exec } from "child_process";
import { promisify } from "util";
const execAsync = promisify(exec);

export const debugEnv = async (req, res) => {
  const commands = [
    "python --version",
    "python3 --version",
    "node --version",
    "java -version",
    "javac -version",
    "gcc --version",
    "g++ --version",
  ];

  const results = {};
  for (const cmd of commands) {
    try {
      const { stdout, stderr } = await execAsync(cmd);
      results[cmd] = stdout || stderr;
    } catch (err) {
      results[cmd] = `NOT FOUND: ${err.message}`;
    }
  }

  res.json(results);
};

