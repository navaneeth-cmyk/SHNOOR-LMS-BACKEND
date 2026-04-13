const splitTopLevelArguments = (value) => {
  const argumentsList = [];
  let current = "";
  let depth = 0;
  let quote = null;
  let escaped = false;

  for (const char of value) {
    if (quote) {
      current += char;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      current += char;
      continue;
    }

    if (char === "(" || char === "[" || char === "{") {
      depth += 1;
      current += char;
      continue;
    }

    if (char === ")" || char === "]" || char === "}") {
      depth = Math.max(0, depth - 1);
      current += char;
      continue;
    }

    if (char === "," && depth === 0) {
      const token = current.trim();
      if (token) argumentsList.push(token);
      current = "";
      continue;
    }

    current += char;
  }

  const lastToken = current.trim();
  if (lastToken) argumentsList.push(lastToken);

  return argumentsList;
};

const stripOuterParentheses = (value) => {
  let trimmed = String(value ?? "").trim();

  while (trimmed.startsWith("(") && trimmed.endsWith(")")) {
    let depth = 0;
    let quote = null;
    let escaped = false;
    let wrapsEntireValue = true;

    for (let index = 0; index < trimmed.length; index += 1) {
      const char = trimmed[index];

      if (quote) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (char === "\\") {
          escaped = true;
          continue;
        }
        if (char === quote) {
          quote = null;
        }
        continue;
      }

      if (char === "'" || char === '"' || char === "`") {
        quote = char;
        continue;
      }

      if (char === "(") depth += 1;
      if (char === ")") depth -= 1;

      if (depth === 0 && index < trimmed.length - 1) {
        wrapsEntireValue = false;
        break;
      }
    }

    if (!wrapsEntireValue) break;
    trimmed = trimmed.slice(1, -1).trim();
  }

  return trimmed;
};

const serializeJavaScriptArgument = (token) => {
  const trimmed = String(token ?? "").trim();
  if (!trimmed) return "undefined";

  if (
    /^(['"]).*\1$/.test(trimmed) ||
    /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?$/i.test(trimmed) ||
    /^(?:true|false|null|undefined|NaN|Infinity|-Infinity)$/.test(trimmed) ||
    /^[\[{]/.test(trimmed) ||
    /^new\s+[A-Za-z_$][\w$]*\s*\(/.test(trimmed)
  ) {
    return trimmed;
  }

  return JSON.stringify(trimmed);
};

const extractJavaScriptEntryPoint = (code) => {
  const source = String(code ?? "");
  const patterns = [
    /\bexport\s+default\s+async\s+function\s+([A-Za-z_$][\w$]*)\s*\(/,
    /\bexport\s+default\s+function\s+([A-Za-z_$][\w$]*)\s*\(/,
    /\bexport\s+async\s+function\s+([A-Za-z_$][\w$]*)\s*\(/,
    /\bexport\s+function\s+([A-Za-z_$][\w$]*)\s*\(/,
    /\basync\s+function\s+([A-Za-z_$][\w$]*)\s*\(/,
    /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/,
    /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?function\s*\(/,
    /\blet\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?function\s*\(/,
    /\bvar\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?function\s*\(/,
    /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/,
    /\blet\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/,
    /\bvar\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/,
  ];

  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match?.[1]) return match[1];
  }

  return null;
};

const formatJavaScriptOutput = (value) => {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

export const buildJavaScriptRuntimeSource = (code, input = "") => {
  const entryPoint = extractJavaScriptEntryPoint(code);
  const normalizedInput = stripOuterParentheses(input);
  const argumentsList = normalizedInput
    ? splitTopLevelArguments(normalizedInput).map(serializeJavaScriptArgument)
    : [];

  const invocation = entryPoint
    ? `const __entry = (typeof ${entryPoint} === "function") ? ${entryPoint} : null;\n  if (!__entry) return;\n  const __result = await __entry(${argumentsList.join(", ")});\n  console.log((${formatJavaScriptOutput.toString()})(__result));`
    : "return;";

  return `${String(code ?? "")}\n\n(async () => {\n  ${invocation}\n})().catch((error) => {\n  console.error(error?.stack || error?.message || String(error));\n  process.exit(1);\n});\n`;
};