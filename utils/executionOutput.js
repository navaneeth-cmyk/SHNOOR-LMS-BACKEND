const normalizeNewlines = (value) =>
  String(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();

const canonicalize = (value) => {
  const normalized = normalizeNewlines(value);
  if (normalized === "") return "";

  try {
    return JSON.stringify(JSON.parse(normalized));
  } catch {
    return normalized
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n");
  }
};

export const compareExecutionOutput = (expectedRaw, actualRaw) => {
  const expected = canonicalize(expectedRaw);
  const actual = canonicalize(actualRaw);

  return {
    passed: expected === actual,
    expected,
    actual,
  };
};
