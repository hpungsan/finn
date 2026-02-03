import { describe, expect, test } from "vitest";
import { normalize } from "./normalize.js";

describe("normalize", () => {
  test("trims leading/trailing whitespace", () => {
    expect(normalize("  foo  ")).toBe("foo");
    expect(normalize("\tfoo\n")).toBe("foo");
  });

  test("lowercases", () => {
    expect(normalize("AUTH_SYSTEM")).toBe("auth_system");
    expect(normalize("Run-123-Explorer")).toBe("run-123-explorer");
  });

  test("collapses internal whitespace to single space", () => {
    expect(normalize("my   workspace")).toBe("my workspace");
    expect(normalize("a\t\nb")).toBe("a b");
  });

  test("preserves hyphens and underscores", () => {
    expect(normalize("my-name")).toBe("my-name");
    expect(normalize("my_name")).toBe("my_name");
  });

  test("combined transformations", () => {
    expect(normalize("  My  Workspace  ")).toBe("my workspace");
    expect(normalize("  AUTH_SYSTEM  ")).toBe("auth_system");
  });

  test("empty and whitespace-only strings", () => {
    expect(normalize("")).toBe("");
    expect(normalize("   ")).toBe("");
  });
});
