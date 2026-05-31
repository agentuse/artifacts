export type FrontmatterValue = string | string[] | FrontmatterGroup;

export interface FrontmatterGroup extends Array<FrontmatterField> {}

export interface FrontmatterField {
  key: string;
  value: FrontmatterValue;
}

export interface ParsedMarkdownFrontmatter {
  body: string;
  fields: FrontmatterField[];
}

const FRONTMATTER_DELIMS = new Set(["---", "..."]);

type YamlValue = string | YamlMap | YamlList;
interface YamlMap {
  [key: string]: YamlValue;
}
interface YamlList extends Array<YamlValue> {}

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
  const parsed = parseYamlMap(lines, 0, 0).value;
  return yamlMapToFields(parsed);
}

function parseYamlBlock(
  lines: string[],
  startIndex: number,
  indent: number,
): { value: YamlValue; nextIndex: number } {
  const next = nextContentLine(lines, startIndex);
  if (next == null) return { value: "", nextIndex: startIndex };

  const info = lineInfo(lines[next]);
  if (!info || info.indent < indent) {
    return { value: "", nextIndex: startIndex };
  }
  if (info.text.startsWith("- ")) {
    return parseYamlList(lines, next, info.indent);
  }
  return parseYamlMap(lines, next, info.indent);
}

function parseYamlMap(
  lines: string[],
  startIndex: number,
  indent: number,
): { value: YamlMap; nextIndex: number } {
  const out: YamlMap = {};
  let i = startIndex;
  while (i < lines.length) {
    const info = lineInfo(lines[i]);
    if (!info) {
      i += 1;
      continue;
    }
    if (info.indent < indent) break;
    if (info.indent > indent) break;
    if (info.text.startsWith("- ")) break;

    const match = parseKeyValue(info.text);
    if (!match) break;

    if (match.rawValue === "|" || match.rawValue === ">") {
      const block = readIndentedBlock(lines, i, info.indent);
      out[match.key] = block.value;
      i = block.nextIndex;
      continue;
    }
    if (match.rawValue) {
      out[match.key] = parseInlineValue(match.rawValue);
      i += 1;
      continue;
    }

    const nested = parseYamlBlock(lines, i + 1, info.indent + 1);
    out[match.key] = nested.value;
    i = nested.nextIndex > i + 1 ? nested.nextIndex : i + 1;
  }
  return { value: out, nextIndex: i };
}

function parseYamlList(
  lines: string[],
  startIndex: number,
  indent: number,
): { value: YamlValue[]; nextIndex: number } {
  const out: YamlValue[] = [];
  let i = startIndex;
  while (i < lines.length) {
    const info = lineInfo(lines[i]);
    if (!info) {
      i += 1;
      continue;
    }
    if (info.indent < indent) break;
    if (info.indent > indent) break;
    if (!info.text.startsWith("- ")) break;

    const rawItem = info.text.slice(2).trim();
    if (!rawItem) {
      const nested = parseYamlBlock(lines, i + 1, info.indent + 1);
      out.push(nested.value);
      i = nested.nextIndex > i + 1 ? nested.nextIndex : i + 1;
      continue;
    }

    const firstPair = parseKeyValue(rawItem);
    if (firstPair) {
      const nestedStart = i + 1;
      let nestedEnd = nestedStart;
      while (nestedEnd < lines.length) {
        const nestedInfo = lineInfo(lines[nestedEnd]);
        if (!nestedInfo) {
          nestedEnd += 1;
          continue;
        }
        if (nestedInfo.indent <= info.indent) break;
        nestedEnd += 1;
      }
      const synthetic = [
        `${" ".repeat(info.indent + 2)}${rawItem}`,
        ...lines.slice(nestedStart, nestedEnd),
      ];
      out.push(parseYamlMap(synthetic, 0, info.indent + 2).value);
      i = nestedEnd;
      continue;
    }

    out.push(cleanScalar(rawItem));
    i += 1;
  }
  return { value: out, nextIndex: i };
}

function yamlMapToFields(value: YamlMap): FrontmatterField[] {
  return Object.entries(value).map(([key, child]) => ({
    key,
    value: yamlValueToFrontmatterValue(child),
  }));
}

function yamlValueToFrontmatterValue(value: YamlValue): FrontmatterValue {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item === "string")) return value as string[];
    return value.map((item, index) => ({
      key: `[${index}]`,
      value: yamlValueToFrontmatterValue(item),
    }));
  }
  return yamlMapToFields(value);
}

function lineInfo(line: string | undefined): { indent: number; text: string } | null {
  if (line == null) return null;
  if (!line.trim() || line.trimStart().startsWith("#")) return null;
  const indent = line.match(/^ */)?.[0].length ?? 0;
  return { indent, text: line.slice(indent) };
}

function nextContentLine(lines: string[], startIndex: number): number | null {
  for (let i = startIndex; i < lines.length; i += 1) {
    if (lineInfo(lines[i])) return i;
  }
  return null;
}

function parseKeyValue(text: string): { key: string; rawValue: string } | null {
  const match = /^([^:][^:]*?):(?:\s*(.*))?$/.exec(text);
  if (!match) return null;
  const key = cleanScalar(match[1]!).trim();
  if (!key) return null;
  return { key, rawValue: (match[2] ?? "").trim() };
}

function readIndentedBlock(
  lines: string[],
  startIndex: number,
  parentIndent = 0,
): { value: string; nextIndex: number } {
  const blockLines: string[] = [];
  let minIndent = Number.POSITIVE_INFINITY;
  let i = startIndex + 1;
  while (i < lines.length) {
    const next = lines[i]!;
    if (next.trim()) {
      const indent = next.match(/^ */)?.[0].length ?? 0;
      if (indent <= parentIndent) break;
      minIndent = Math.min(minIndent, indent);
    }
    blockLines.push(next);
    i += 1;
  }
  const trimIndent = Number.isFinite(minIndent) ? minIndent : parentIndent + 2;
  return {
    value: blockLines
      .map((line) => line.slice(Math.min(line.length, trimIndent)))
      .join("\n")
      .trim(),
    nextIndex: i,
  };
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
