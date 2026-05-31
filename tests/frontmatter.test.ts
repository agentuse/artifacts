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

  it("renders nested and block scalar values as text", () => {
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
      { key: "agent", value: "model: gpt\nprovider: openai" },
      { key: "summary", value: "Line one\nLine two" },
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
