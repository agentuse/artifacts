import { describe, expect, it } from "vitest";
import { parseMarkdownFrontmatter } from "../viewer/src/frontmatter";

describe("parseMarkdownFrontmatter", () => {
  it("extracts scalar fields and strips the frontmatter from the body", () => {
    const parsed = parseMarkdownFrontmatter(`---
title: "Weekly Report"
owner: Leon
published: true
---

# Body
`);

    expect(parsed.fields).toEqual([
      { key: "title", value: "Weekly Report" },
      { key: "owner", value: "Leon" },
      { key: "published", value: "true" },
    ]);
    expect(parsed.body).toBe("# Body\n");
  });

  it("extracts inline and block lists", () => {
    const parsed = parseMarkdownFrontmatter(`---
tags: [growth, "product ops"]
audiences:
  - founder
  - operator
---
Body`);

    expect(parsed.fields).toEqual([
      { key: "tags", value: ["growth", "product ops"] },
      { key: "audiences", value: ["founder", "operator"] },
    ]);
    expect(parsed.body).toBe("Body");
  });

  it("preserves nested maps and block scalar values", () => {
    const parsed = parseMarkdownFrontmatter(`---
agent:
  model: gpt
  provider: openai
summary: |
  Line one
  Line two
---
Body`);

    expect(parsed.fields).toEqual([
      {
        key: "agent",
        value: [
          { key: "model", value: "gpt" },
          { key: "provider", value: "openai" },
        ],
      },
      { key: "summary", value: "Line one\nLine two" },
    ]);
  });

  it("preserves multi-level YAML maps and nested scalar lists", () => {
    const parsed = parseMarkdownFrontmatter(`---
tools:
  filesystem:
    permissions: [read, write, edit]
  bash:
    commands:
      - python
      - curl
runtime:
  schedule:
    timezone: America/Vancouver
    days:
      - monday
      - friday
---
Body`);

    expect(parsed.fields).toEqual([
      {
        key: "tools",
        value: [
          {
            key: "filesystem",
            value: [
              { key: "permissions", value: ["read", "write", "edit"] },
            ],
          },
          {
            key: "bash",
            value: [
              { key: "commands", value: ["python", "curl"] },
            ],
          },
        ],
      },
      {
        key: "runtime",
        value: [
          {
            key: "schedule",
            value: [
              { key: "timezone", value: "America/Vancouver" },
              { key: "days", value: ["monday", "friday"] },
            ],
          },
        ],
      },
    ]);
  });

  it("preserves YAML lists of objects with stable indexes", () => {
    const parsed = parseMarkdownFrontmatter(`---
agents:
  - name: writer
    model: claude
  - name: reviewer
    model: gpt
---
Body`);

    expect(parsed.fields).toEqual([
      {
        key: "agents",
        value: [
          {
            key: "[0]",
            value: [
              { key: "name", value: "writer" },
              { key: "model", value: "claude" },
            ],
          },
          {
            key: "[1]",
            value: [
              { key: "name", value: "reviewer" },
              { key: "model", value: "gpt" },
            ],
          },
        ],
      },
    ]);
  });

  it("leaves ordinary markdown untouched when no closing delimiter exists", () => {
    const source = `---

This is just a thematic break.
`;
    expect(parseMarkdownFrontmatter(source)).toEqual({ body: source, fields: [] });
  });

  it("leaves ordinary markdown untouched when no fields are present", () => {
    const source = `---

Intro

---

Body`;
    expect(parseMarkdownFrontmatter(source)).toEqual({ body: source, fields: [] });
  });
});
