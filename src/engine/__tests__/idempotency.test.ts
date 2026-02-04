import { describe, expect, test } from "vitest";
import {
  canonicalizeInputs,
  computeInputsDigest,
  computeStepIdempotency,
  computeStepInstanceId,
  normalizePath,
  stableStringify,
} from "../idempotency.js";
import type { ArtifactInputRef, StepInputs, StepVersioning } from "../types.js";

describe("normalizePath", () => {
  test("converts backslashes to forward slashes", () => {
    expect(normalizePath("a\\b\\c")).toBe("a/b/c");
  });

  test("removes trailing slash", () => {
    expect(normalizePath("foo/bar/")).toBe("foo/bar");
  });

  test("preserves root slash", () => {
    expect(normalizePath("/")).toBe("/");
  });

  test("returns already normalized path unchanged", () => {
    expect(normalizePath("a/b/c")).toBe("a/b/c");
  });

  test("handles empty string", () => {
    expect(normalizePath("")).toBe("");
  });

  test("normalizes Windows path", () => {
    expect(normalizePath("C:\\Users\\foo")).toBe("C:/Users/foo");
  });

  test("handles multiple trailing slashes", () => {
    expect(normalizePath("foo/bar//")).toBe("foo/bar");
    expect(normalizePath("foo/bar///")).toBe("foo/bar");
  });

  test("handles path with spaces", () => {
    expect(normalizePath("a\\b c\\d")).toBe("a/b c/d");
  });
});

describe("stableStringify", () => {
  test("handles null", () => {
    expect(stableStringify(null)).toBe("null");
  });

  test("handles boolean true", () => {
    expect(stableStringify(true)).toBe("true");
  });

  test("handles boolean false", () => {
    expect(stableStringify(false)).toBe("false");
  });

  test("handles number", () => {
    expect(stableStringify(123)).toBe("123");
  });

  test("handles string", () => {
    expect(stableStringify("hello")).toBe('"hello"');
  });

  test("preserves array order", () => {
    expect(stableStringify([3, 1, 2])).toBe("[3,1,2]");
  });

  test("sorts object keys", () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  test("handles nested objects with sorted keys", () => {
    expect(stableStringify({ z: { b: 1, a: 2 }, a: 1 })).toBe(
      '{"a":1,"z":{"a":2,"b":1}}',
    );
  });

  test("produces same output for objects with different key order", () => {
    const obj1 = { a: 1, b: 2 };
    const obj2 = { b: 2, a: 1 };
    expect(stableStringify(obj1)).toBe(stableStringify(obj2));
  });

  test("omits undefined values", () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  test("keeps null values", () => {
    expect(stableStringify({ a: null })).toBe('{"a":null}');
  });

  test("handles empty object", () => {
    expect(stableStringify({})).toBe("{}");
  });

  test("handles empty array", () => {
    expect(stableStringify([])).toBe("[]");
  });

  test("converts undefined in arrays to null", () => {
    expect(stableStringify([1, undefined, 3])).toBe("[1,null,3]");
  });

  test("handles array of objects", () => {
    expect(
      stableStringify([
        { b: 1, a: 2 },
        { d: 3, c: 4 },
      ]),
    ).toBe('[{"a":2,"b":1},{"c":4,"d":3}]');
  });

  test("handles deeply nested structures", () => {
    const deep = { a: { b: { c: { d: 1 } } } };
    expect(stableStringify(deep)).toBe('{"a":{"b":{"c":{"d":1}}}}');
  });

  test("handles special characters in strings", () => {
    expect(stableStringify({ key: 'value"with"quotes' })).toBe(
      '{"key":"value\\"with\\"quotes"}',
    );
  });

  test("handles unicode", () => {
    expect(stableStringify({ emoji: "🚀", text: "日本語" })).toBe(
      '{"emoji":"🚀","text":"日本語"}',
    );
  });
});

describe("canonicalizeInputs", () => {
  test("returns empty object for empty inputs", () => {
    expect(canonicalizeInputs({})).toEqual({});
  });

  test("sorts artifact_refs by workspace then name", () => {
    const refs: ArtifactInputRef[] = [
      { workspace: "b", name: "z", version: 1 },
      { workspace: "a", name: "y", version: 2 },
      { workspace: "a", name: "x", version: 3 },
    ];
    const result = canonicalizeInputs({ artifact_refs: refs });
    expect(result.artifact_refs).toEqual([
      { workspace: "a", name: "x", version: 3 },
      { workspace: "a", name: "y", version: 2 },
      { workspace: "b", name: "z", version: 1 },
    ]);
  });

  test("sorts artifact_refs with only id correctly", () => {
    const refs: ArtifactInputRef[] = [
      { workspace: "a", id: "id-2", version: 1 },
      { workspace: "a", id: "id-1", version: 2 },
    ];
    const result = canonicalizeInputs({ artifact_refs: refs });
    expect(result.artifact_refs).toEqual([
      { workspace: "a", id: "id-1", version: 2 },
      { workspace: "a", id: "id-2", version: 1 },
    ]);
  });

  test("normalizes and sorts file_paths", () => {
    const result = canonicalizeInputs({
      file_paths: ["c/d", "a\\b", "e/f/"],
    });
    expect(result.file_paths).toEqual(["a/b", "c/d", "e/f"]);
  });

  test("omits empty artifact_refs array", () => {
    const result = canonicalizeInputs({ artifact_refs: [] });
    expect(result.artifact_refs).toBeUndefined();
  });

  test("omits empty file_paths array", () => {
    const result = canonicalizeInputs({ file_paths: [] });
    expect(result.file_paths).toBeUndefined();
  });

  test("omits empty params object", () => {
    const result = canonicalizeInputs({ params: {} });
    expect(result.params).toBeUndefined();
  });

  test("does not mutate original input", () => {
    const original: StepInputs = {
      file_paths: ["c", "a", "b"],
      artifact_refs: [
        { workspace: "b", name: "x", version: 1 },
        { workspace: "a", name: "y", version: 2 },
      ],
    };
    const originalCopy = JSON.parse(JSON.stringify(original));
    canonicalizeInputs(original);
    expect(original).toEqual(originalCopy);
  });

  test("preserves repo_hash when present", () => {
    const result = canonicalizeInputs({ repo_hash: "abc123" });
    expect(result.repo_hash).toBe("abc123");
  });

  test("omits repo_hash when undefined", () => {
    const result = canonicalizeInputs({ repo_hash: undefined });
    expect(result.repo_hash).toBeUndefined();
  });

  test("preserves non-empty params", () => {
    const result = canonicalizeInputs({ params: { key: "value" } });
    expect(result.params).toEqual({ key: "value" });
  });

  test("throws if artifact_ref has neither name nor id", () => {
    const refs: ArtifactInputRef[] = [
      { workspace: "ws", version: 1 } as ArtifactInputRef,
    ];
    expect(() => canonicalizeInputs({ artifact_refs: refs })).toThrow(
      "ArtifactInputRef requires name or id",
    );
  });
});

describe("computeInputsDigest", () => {
  test("produces 64-char hex string", () => {
    const digest = computeInputsDigest({});
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
  });

  test("equivalent inputs produce same digest", () => {
    const inputs1: StepInputs = { file_paths: ["b", "a"] };
    const inputs2: StepInputs = { file_paths: ["a", "b"] };
    expect(computeInputsDigest(inputs1)).toBe(computeInputsDigest(inputs2));
  });

  test("different inputs produce different digest", () => {
    const inputs1: StepInputs = { file_paths: ["a"] };
    const inputs2: StepInputs = { file_paths: ["b"] };
    expect(computeInputsDigest(inputs1)).not.toBe(computeInputsDigest(inputs2));
  });

  test("artifact version change produces different digest", () => {
    const inputs1: StepInputs = {
      artifact_refs: [{ workspace: "test", name: "art", version: 1 }],
    };
    const inputs2: StepInputs = {
      artifact_refs: [{ workspace: "test", name: "art", version: 2 }],
    };
    expect(computeInputsDigest(inputs1)).not.toBe(computeInputsDigest(inputs2));
  });

  test("repo_hash change produces different digest", () => {
    const inputs1: StepInputs = { repo_hash: "hash1" };
    const inputs2: StepInputs = { repo_hash: "hash2" };
    expect(computeInputsDigest(inputs1)).not.toBe(computeInputsDigest(inputs2));
  });

  test("path normalization applied - backslash vs forward slash same digest", () => {
    const inputs1: StepInputs = { file_paths: ["a\\b\\c"] };
    const inputs2: StepInputs = { file_paths: ["a/b/c"] };
    expect(computeInputsDigest(inputs1)).toBe(computeInputsDigest(inputs2));
  });

  test("empty inputs produce consistent digest", () => {
    expect(computeInputsDigest({})).toBe(computeInputsDigest({}));
  });
});

describe("computeStepInstanceId", () => {
  const versioning: StepVersioning = {
    model: "claude-3",
    schema_version: "1.0",
    prompt_version: "v1",
  };

  test("produces 64-char hex string", () => {
    const id = computeStepInstanceId("step-1", "digest-123", versioning);
    expect(id).toMatch(/^[a-f0-9]{64}$/);
  });

  test("same inputs produce same id", () => {
    const id1 = computeStepInstanceId("step-1", "digest-123", versioning);
    const id2 = computeStepInstanceId("step-1", "digest-123", versioning);
    expect(id1).toBe(id2);
  });

  test("different step_id produces different id", () => {
    const id1 = computeStepInstanceId("step-1", "digest-123", versioning);
    const id2 = computeStepInstanceId("step-2", "digest-123", versioning);
    expect(id1).not.toBe(id2);
  });

  test("different inputs_digest produces different id", () => {
    const id1 = computeStepInstanceId("step-1", "digest-123", versioning);
    const id2 = computeStepInstanceId("step-1", "digest-456", versioning);
    expect(id1).not.toBe(id2);
  });

  test("different model produces different id", () => {
    const v1: StepVersioning = { ...versioning, model: "claude-3" };
    const v2: StepVersioning = { ...versioning, model: "claude-4" };
    const id1 = computeStepInstanceId("step-1", "digest-123", v1);
    const id2 = computeStepInstanceId("step-1", "digest-123", v2);
    expect(id1).not.toBe(id2);
  });

  test("different schema_version produces different id", () => {
    const v1: StepVersioning = { ...versioning, schema_version: "1.0" };
    const v2: StepVersioning = { ...versioning, schema_version: "2.0" };
    const id1 = computeStepInstanceId("step-1", "digest-123", v1);
    const id2 = computeStepInstanceId("step-1", "digest-123", v2);
    expect(id1).not.toBe(id2);
  });

  test("different prompt_version produces different id", () => {
    const v1: StepVersioning = { ...versioning, prompt_version: "v1" };
    const v2: StepVersioning = { ...versioning, prompt_version: "v2" };
    const id1 = computeStepInstanceId("step-1", "digest-123", v1);
    const id2 = computeStepInstanceId("step-1", "digest-123", v2);
    expect(id1).not.toBe(id2);
  });
});

describe("computeStepIdempotency", () => {
  const versioning: StepVersioning = {
    model: "claude-3",
    schema_version: "1.0",
    prompt_version: "v1",
  };

  test("returns both inputs_digest and step_instance_id", () => {
    const result = computeStepIdempotency("step-1", {}, versioning);
    expect(result).toHaveProperty("inputs_digest");
    expect(result).toHaveProperty("step_instance_id");
  });

  test("inputs_digest matches computeInputsDigest result", () => {
    const inputs: StepInputs = { repo_hash: "test-hash" };
    const result = computeStepIdempotency("step-1", inputs, versioning);
    expect(result.inputs_digest).toBe(computeInputsDigest(inputs));
  });

  test("step_instance_id matches computeStepInstanceId result", () => {
    const inputs: StepInputs = { repo_hash: "test-hash" };
    const result = computeStepIdempotency("step-1", inputs, versioning);
    const expectedInstanceId = computeStepInstanceId(
      "step-1",
      result.inputs_digest,
      versioning,
    );
    expect(result.step_instance_id).toBe(expectedInstanceId);
  });

  test("upstream artifact version change produces new instance_id", () => {
    const inputs1: StepInputs = {
      artifact_refs: [{ workspace: "ws", name: "art", version: 1 }],
    };
    const inputs2: StepInputs = {
      artifact_refs: [{ workspace: "ws", name: "art", version: 2 }],
    };
    const result1 = computeStepIdempotency("step-1", inputs1, versioning);
    const result2 = computeStepIdempotency("step-1", inputs2, versioning);
    expect(result1.step_instance_id).not.toBe(result2.step_instance_id);
  });

  test("repo_hash change produces new instance_id", () => {
    const inputs1: StepInputs = { repo_hash: "hash1" };
    const inputs2: StepInputs = { repo_hash: "hash2" };
    const result1 = computeStepIdempotency("step-1", inputs1, versioning);
    const result2 = computeStepIdempotency("step-1", inputs2, versioning);
    expect(result1.step_instance_id).not.toBe(result2.step_instance_id);
  });
});

describe("edge cases", () => {
  test("empty inputs produce consistent digest across calls", () => {
    const digest1 = computeInputsDigest({});
    const digest2 = computeInputsDigest({});
    expect(digest1).toBe(digest2);
  });

  test("deeply nested params (3+ levels)", () => {
    const inputs: StepInputs = {
      params: {
        level1: {
          level2: {
            level3: {
              level4: "value",
            },
          },
        },
      },
    };
    const digest = computeInputsDigest(inputs);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
  });

  test("unicode in paths and params", () => {
    const inputs: StepInputs = {
      file_paths: ["日本語/ファイル.ts", "emoji/🚀.ts"],
      params: { key: "值", emoji: "🎉" },
    };
    const digest = computeInputsDigest(inputs);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
  });

  test("special characters in paths: spaces, parens, brackets", () => {
    const inputs: StepInputs = {
      file_paths: [
        "path with spaces/file.ts",
        "path(parens)/file.ts",
        "path[brackets]/file.ts",
      ],
    };
    const digest = computeInputsDigest(inputs);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
  });

  test("large params object (1000+ keys) - no stack overflow", () => {
    const params: Record<string, number> = {};
    for (let i = 0; i < 1000; i++) {
      params[`key${i}`] = i;
    }
    const inputs: StepInputs = { params };
    const digest = computeInputsDigest(inputs);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
  });

  test("params with null vs undefined distinguished", () => {
    const inputs1: StepInputs = { params: { key: null } };
    const inputs2: StepInputs = { params: { key: undefined } };
    // With undefined key, params becomes empty and is omitted
    const digest1 = computeInputsDigest(inputs1);
    const digest2 = computeInputsDigest(inputs2);
    expect(digest1).not.toBe(digest2);
  });

  test("mixed artifact_refs with name and id", () => {
    const refs: ArtifactInputRef[] = [
      { workspace: "ws", name: "named-art", version: 1 },
      { workspace: "ws", id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", version: 2 },
    ];
    const result = canonicalizeInputs({ artifact_refs: refs });
    // id sorts before name (both are strings, lexicographic)
    expect(result.artifact_refs?.[0].id).toBe("01ARZ3NDEKTSV4RRFFQ69G5FAV");
    expect(result.artifact_refs?.[1].name).toBe("named-art");
  });
});
