export interface FrontmatterField {
  key: string;
  value: string | string[];
}

export interface ParsedMarkdownFrontmatter {
  body: string;
  fields: FrontmatterField[];
}

const FRONTMATTER_DELIMS = new Set(["---", "..."]);

export function parseMarkdownFrontmatter(source: string): ParsedMarkdownFrontmatter {
  const normalized = source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  if (lines[0]?.trim() !== "---") return { body: source, fields: [] };

  let close = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (FRONTMATTER_DELIMS.has(lines[i]!.trim())) {
      close = i;
      break;
    }
  }
  if (close === -1) return { body: source, fields: [] };

  const fields = parseFrontmatterLines(lines.slice(1, close));
  if (fields.length === 0) return { body: source, fields: [] };
  return {
    body: lines.slice(close + 1).join("\n").replace(/^\n/, ""),
    fields,
  };
}

function parseFrontmatterLines(lines: string[]): FrontmatterField[] {
  const fields: FrontmatterField[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (!line.trim() || line.trimStart().startsWith("#")) continue;

    const match = /^([A-Za-z0-9_.-]+):(?:\s*(.*))?$/.exec(line);
    if (!match) continue;

    const key = match[1]!;
    const rawValue = match[2] ?? "";
    if (rawValue.trim() === "|" || rawValue.trim() === ">") {
      const block = readIndentedBlock(lines, i);
      i = block.nextIndex;
      fields.push({ key, value: block.value });
      continue;
    }
    if (rawValue.trim()) {
      fields.push({ key, value: parseInlineValue(rawValue) });
      continue;
    }

    const items: string[] = [];
    const blockLines: string[] = [];
    while (i + 1 < lines.length) {
      const next = lines[i + 1]!;
      if (!/^\s+/.test(next) && next.trim()) break;
      const item = /^\s*-\s+(.*)$/.exec(next);
      if (item) items.push(cleanScalar(item[1]!));
      else blockLines.push(next.replace(/^\s{2,}/, ""));
      i += 1;
    }
    fields.push({
      key,
      value: items.length && blockLines.every((line) => !line.trim())
        ? items
        : blockLines.join("\n").trim(),
    });
  }
  return fields;
}

function readIndentedBlock(lines: string[], startIndex: number): { value: string; nextIndex: number } {
  const blockLines: string[] = [];
  let i = startIndex;
  while (i + 1 < lines.length) {
    const next = lines[i + 1]!;
    if (!/^\s+/.test(next) && next.trim()) break;
    blockLines.push(next.replace(/^\s{2,}/, ""));
    i += 1;
  }
  return { value: blockLines.join("\n").trim(), nextIndex: i };
}

function parseInlineValue(raw: string): string | string[] {
  const value = raw.trim();
  if (value.startsWith("[") && value.endsWith("]")) {
    return splitInlineList(value.slice(1, -1)).map(cleanScalar).filter(Boolean);
  }
  return cleanScalar(value);
}

function splitInlineList(raw: string): string[] {
  const items: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (const char of raw) {
    if ((char === '"' || char === "'") && quote == null) {
      quote = char;
      cur += char;
      continue;
    }
    if (char === quote) {
      quote = null;
      cur += char;
      continue;
    }
    if (char === "," && quote == null) {
      items.push(cur);
      cur = "";
      continue;
    }
    cur += char;
  }
  if (cur.trim()) items.push(cur);
  return items;
}

function cleanScalar(raw: string): string {
  const value = raw.trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
