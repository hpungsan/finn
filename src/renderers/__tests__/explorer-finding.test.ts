import { describe, expect, test } from "vitest";
import type { ExplorerFinding } from "../../schemas/index.js";
import { renderExplorerFinding } from "../explorer-finding.js";

describe("renderExplorerFinding", () => {
  test("renders complete finding with all fields", () => {
    const finding: ExplorerFinding = {
      files: [
        {
          path: "src/auth.ts",
          relevance: "high",
          summary: "Add JWT validation",
        },
        {
          path: "src/config.ts",
          relevance: "medium",
          summary: "Update config",
        },
        { path: "src/types.ts", relevance: "low", summary: "Add types" },
      ],
      patterns: ["middleware chain", "token validation"],
      concerns: ["Token expiry unclear"],
      confidence: 0.85,
    };

    const result = renderExplorerFinding(finding);

    // Check structure
    expect(result).toContain("**Confidence:** 0.85");
    expect(result).toContain("### Files");
    expect(result).toContain("**High Relevance:**");
    expect(result).toContain("**Medium Relevance:**");
    expect(result).toContain("**Low Relevance:**");
    expect(result).toContain("### Patterns");
    expect(result).toContain("### Concerns");

    // Check file formatting
    expect(result).toContain("- `src/auth.ts` - Add JWT validation");
    expect(result).toContain("- `src/config.ts` - Update config");
    expect(result).toContain("- `src/types.ts` - Add types");

    // Check patterns and concerns
    expect(result).toContain("- middleware chain");
    expect(result).toContain("- Token expiry unclear");
  });

  test("handles empty files array", () => {
    const finding: ExplorerFinding = {
      files: [],
      patterns: ["some pattern"],
      concerns: [],
      confidence: 0.5,
    };

    const result = renderExplorerFinding(finding);

    expect(result).not.toContain("### Files");
    expect(result).toContain("### Patterns");
    expect(result).not.toContain("### Concerns");
  });

  test("handles empty patterns and concerns", () => {
    const finding: ExplorerFinding = {
      files: [{ path: "x.ts", relevance: "high", summary: "test" }],
      patterns: [],
      concerns: [],
      confidence: 0.75,
    };

    const result = renderExplorerFinding(finding);

    expect(result).toContain("### Files");
    expect(result).not.toContain("### Patterns");
    expect(result).not.toContain("### Concerns");
  });

  test("only shows relevance groups that have files", () => {
    const finding: ExplorerFinding = {
      files: [
        { path: "a.ts", relevance: "high", summary: "high file" },
        { path: "b.ts", relevance: "high", summary: "another high" },
      ],
      patterns: [],
      concerns: [],
      confidence: 0.9,
    };

    const result = renderExplorerFinding(finding);

    expect(result).toContain("**High Relevance:**");
    expect(result).not.toContain("**Medium Relevance:**");
    expect(result).not.toContain("**Low Relevance:**");
  });

  test("formats confidence with two decimal places", () => {
    const finding: ExplorerFinding = {
      files: [],
      patterns: [],
      concerns: [],
      confidence: 0.123456,
    };

    const result = renderExplorerFinding(finding);

    expect(result).toContain("**Confidence:** 0.12");
  });

  test("handles confidence boundary values", () => {
    const minConfidence: ExplorerFinding = {
      files: [],
      patterns: [],
      concerns: [],
      confidence: 0,
    };

    const maxConfidence: ExplorerFinding = {
      files: [],
      patterns: [],
      concerns: [],
      confidence: 1,
    };

    expect(renderExplorerFinding(minConfidence)).toContain(
      "**Confidence:** 0.00",
    );
    expect(renderExplorerFinding(maxConfidence)).toContain(
      "**Confidence:** 1.00",
    );
  });

  test("handles minimal finding (all empty arrays)", () => {
    const minimal: ExplorerFinding = {
      files: [],
      patterns: [],
      concerns: [],
      confidence: 0.5,
    };

    const result = renderExplorerFinding(minimal);

    // Should only have confidence
    expect(result).toBe("**Confidence:** 0.50");
  });

  test("preserves special characters in paths and summaries", () => {
    const finding: ExplorerFinding = {
      files: [
        {
          path: "src/utils/string-helpers.ts",
          relevance: "high",
          summary: "Handle 'quoted' & special <chars>",
        },
      ],
      patterns: [],
      concerns: [],
      confidence: 0.8,
    };

    const result = renderExplorerFinding(finding);

    expect(result).toContain("`src/utils/string-helpers.ts`");
    expect(result).toContain("Handle 'quoted' & special <chars>");
  });

  test("orders relevance groups high → medium → low", () => {
    const finding: ExplorerFinding = {
      files: [
        { path: "low.ts", relevance: "low", summary: "low" },
        { path: "high.ts", relevance: "high", summary: "high" },
        { path: "medium.ts", relevance: "medium", summary: "medium" },
      ],
      patterns: [],
      concerns: [],
      confidence: 0.5,
    };

    const result = renderExplorerFinding(finding);

    const highIndex = result.indexOf("**High Relevance:**");
    const mediumIndex = result.indexOf("**Medium Relevance:**");
    const lowIndex = result.indexOf("**Low Relevance:**");

    expect(highIndex).toBeLessThan(mediumIndex);
    expect(mediumIndex).toBeLessThan(lowIndex);
  });
});
