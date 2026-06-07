import { existsSync, readFileSync } from "node:fs";

export function loadEnvFile(path) {
  if (!existsSync(path)) {
    return new Map();
  }

  return parseEnvContent(readFileSync(path, "utf8"));
}

export function parseEnvContent(content) {
  const values = new Map();

  for (const line of content.split(/\r?\n/u)) {
    const parsed = parseEnvLine(line);
    if (parsed) {
      values.set(parsed.key, parsed.value);
    }
  }

  return values;
}

export function parseEnvLine(line) {
  const trimmed = line.trimStart();
  if (!trimmed || trimmed.startsWith("#")) {
    return undefined;
  }

  const candidate = trimmed.replace(/^export\s+/u, "");
  const match = candidate.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/u);
  if (!match) {
    return undefined;
  }

  return {
    key: match[1],
    value: parseEnvValue(match[2])
  };
}

export function formatEnvValue(value) {
  const text = String(value);
  if (text === "") {
    return "";
  }

  if (text.trim() === text && !/[\s#"'\\]/u.test(text)) {
    return text;
  }

  return `"${text
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t")
    .replaceAll('"', '\\"')}"`;
}

function parseEnvValue(rawValue) {
  const value = rawValue.trim();
  if (value === "") {
    return "";
  }

  if (value.startsWith('"')) {
    return parseQuotedValue(value, '"', true);
  }

  if (value.startsWith("'")) {
    return parseQuotedValue(value, "'", false);
  }

  return stripInlineComment(value).trimEnd();
}

function parseQuotedValue(value, quote, decodeEscapes) {
  let parsed = "";
  let escaped = false;

  for (let index = 1; index < value.length; index += 1) {
    const char = value[index];

    if (decodeEscapes && escaped) {
      parsed += decodeDoubleQuotedEscape(char);
      escaped = false;
      continue;
    }

    if (decodeEscapes && char === "\\") {
      escaped = true;
      continue;
    }

    if (char === quote) {
      return parsed;
    }

    parsed += char;
  }

  if (escaped) {
    parsed += "\\";
  }

  return parsed;
}

function decodeDoubleQuotedEscape(char) {
  switch (char) {
    case "n":
      return "\n";
    case "r":
      return "\r";
    case "t":
      return "\t";
    case '"':
      return '"';
    case "\\":
      return "\\";
    default:
      return `\\${char}`;
  }
}

function stripInlineComment(value) {
  for (let index = 1; index < value.length; index += 1) {
    if (value[index] === "#" && /\s/u.test(value[index - 1])) {
      return value.slice(0, index);
    }
  }

  return value;
}
