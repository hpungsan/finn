import { describe, expect, test } from "vitest";
import { ExplorerFindingSchema } from "../explorer-finding.js";

describe("ExplorerFindingSchema", () => {
  test("validates valid finding", () => {
    const valid = {
      files: [
        { path: "src/auth.ts", relevance: "high", summary: "Auth logic" },
      ],
      patterns: ["middleware chain"],
      concerns: ["Token expiry unclear"],
      confidence: 0.85,
    };
    expect(ExplorerFindingSchema.parse(valid)).toEqual(valid);
  });

  test("rejects invalid relevance", () => {
    const invalid = {
      files: [{ path: "x.ts", relevance: "critical", summary: "x" }],
      patterns: [],
      concerns: [],
      confidence: 0.5,
    };
    expect(() => ExplorerFindingSchema.parse(invalid)).toThrow();
  });

  test("rejects confidence out of range", () => {
    const invalid = {
      files: [],
      patterns: [],
      concerns: [],
      confidence: 1.5,
    };
    expect(() => ExplorerFindingSchema.parse(invalid)).toThrow();
  });
});
