import { describe, expect, test } from "vitest";
import { groupIntoBatches } from "../batch.js";
import { topoSort } from "../executor.js";
import type { Step } from "../types.js";

function createMockStep(overrides: Partial<Step> & { id: string }): Step {
  return {
    name: overrides.id,
    deps: [],
    timeout: 60_000,
    maxRetries: 2,
    model: "sonnet",
    prompt_version: "v1",
    schema_version: "1.0",
    getInputs: () => ({}),
    run: async () => ({ status: "OK", artifact_ids: [] }),
    ...overrides,
  };
}

describe("groupIntoBatches", () => {
  test("empty array returns empty batches", () => {
    expect(groupIntoBatches([])).toEqual([]);
  });

  test("single step returns single batch with that step", () => {
    const a = createMockStep({ id: "a" });
    const sorted = topoSort([a]);
    const batches = groupIntoBatches(sorted);

    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(1);
    expect(batches[0][0].id).toBe("a");
  });

  test("linear chain produces one step per batch", () => {
    // a → b → c
    const a = createMockStep({ id: "a" });
    const b = createMockStep({ id: "b", deps: ["a"] });
    const c = createMockStep({ id: "c", deps: ["b"] });

    const sorted = topoSort([c, b, a]);
    const batches = groupIntoBatches(sorted);

    expect(batches).toHaveLength(3);
    expect(batches[0].map((s) => s.id)).toEqual(["a"]);
    expect(batches[1].map((s) => s.id)).toEqual(["b"]);
    expect(batches[2].map((s) => s.id)).toEqual(["c"]);
  });

  test("diamond dependency produces correct level grouping", () => {
    //   a
    //  / \
    // b   c
    //  \ /
    //   d
    const a = createMockStep({ id: "a" });
    const b = createMockStep({ id: "b", deps: ["a"] });
    const c = createMockStep({ id: "c", deps: ["a"] });
    const d = createMockStep({ id: "d", deps: ["b", "c"] });

    const sorted = topoSort([d, c, b, a]);
    const batches = groupIntoBatches(sorted);

    expect(batches).toHaveLength(3);
    expect(batches[0].map((s) => s.id)).toEqual(["a"]);
    expect(batches[1].map((s) => s.id).sort()).toEqual(["b", "c"]);
    expect(batches[2].map((s) => s.id)).toEqual(["d"]);
  });

  test("independent steps go in same batch (level 0)", () => {
    const a = createMockStep({ id: "a" });
    const b = createMockStep({ id: "b" });
    const c = createMockStep({ id: "c" });

    const sorted = topoSort([a, b, c]);
    const batches = groupIntoBatches(sorted);

    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(3);
    expect(batches[0].map((s) => s.id).sort()).toEqual(["a", "b", "c"]);
  });

  test("complex graph with multiple levels", () => {
    //   a     e
    //  / \     \
    // b   c     f
    //  \ /|    /
    //   d  g--
    //
    // Levels:
    //   Level 0: a, e (no deps)
    //   Level 1: b, c, f (deps on level 0)
    //   Level 2: d, g (deps include level 1)
    const a = createMockStep({ id: "a" });
    const b = createMockStep({ id: "b", deps: ["a"] });
    const c = createMockStep({ id: "c", deps: ["a"] });
    const d = createMockStep({ id: "d", deps: ["b", "c"] });
    const e = createMockStep({ id: "e" });
    const f = createMockStep({ id: "f", deps: ["e"] });
    const g = createMockStep({ id: "g", deps: ["c", "f"] });

    const sorted = topoSort([a, b, c, d, e, f, g]);
    const batches = groupIntoBatches(sorted);

    expect(batches).toHaveLength(3);

    // Level 0: a, e (no deps)
    expect(batches[0].map((s) => s.id).sort()).toEqual(["a", "e"]);

    // Level 1: b, c, f (deps on level 0)
    expect(batches[1].map((s) => s.id).sort()).toEqual(["b", "c", "f"]);

    // Level 2: d, g (deps include level 1)
    expect(batches[2].map((s) => s.id).sort()).toEqual(["d", "g"]);
  });

  test("deterministic ordering - same input produces same output", () => {
    const a = createMockStep({ id: "a" });
    const b = createMockStep({ id: "b", deps: ["a"] });
    const c = createMockStep({ id: "c", deps: ["a"] });
    const d = createMockStep({ id: "d", deps: ["b", "c"] });

    const input = [d, c, b, a];
    const sorted = topoSort(input);

    const batches1 = groupIntoBatches(sorted);
    const batches2 = groupIntoBatches(sorted);

    expect(batches1.map((b) => b.map((s) => s.id))).toEqual(
      batches2.map((b) => b.map((s) => s.id)),
    );
  });

  test("wide graph - many parallel steps", () => {
    const root = createMockStep({ id: "root" });
    const children = Array.from({ length: 10 }, (_, i) =>
      createMockStep({ id: `child-${i}`, deps: ["root"] }),
    );
    const sink = createMockStep({
      id: "sink",
      deps: children.map((c) => c.id),
    });

    const sorted = topoSort([sink, ...children, root]);
    const batches = groupIntoBatches(sorted);

    expect(batches).toHaveLength(3);
    expect(batches[0].map((s) => s.id)).toEqual(["root"]);
    expect(batches[1]).toHaveLength(10);
    expect(batches[2].map((s) => s.id)).toEqual(["sink"]);
  });

  test("deep graph - long dependency chain", () => {
    const steps: Step[] = [];
    for (let i = 0; i < 5; i++) {
      steps.push(
        createMockStep({
          id: `step-${i}`,
          deps: i > 0 ? [`step-${i - 1}`] : [],
        }),
      );
    }

    const sorted = topoSort(steps.reverse());
    const batches = groupIntoBatches(sorted);

    expect(batches).toHaveLength(5);
    for (let i = 0; i < 5; i++) {
      expect(batches[i]).toHaveLength(1);
      expect(batches[i][0].id).toBe(`step-${i}`);
    }
  });

  test("step with multiple deps at different levels gets correct level", () => {
    // a → b → c
    //   ↘   ↗
    //     d (deps on a AND b, should be level 2 like c)
    const a = createMockStep({ id: "a" });
    const b = createMockStep({ id: "b", deps: ["a"] });
    const c = createMockStep({ id: "c", deps: ["b"] });
    const d = createMockStep({ id: "d", deps: ["a", "b"] });

    const sorted = topoSort([a, b, c, d]);
    const batches = groupIntoBatches(sorted);

    expect(batches).toHaveLength(3);
    expect(batches[0].map((s) => s.id)).toEqual(["a"]);
    expect(batches[1].map((s) => s.id)).toEqual(["b"]);
    // c and d both have max dep level = 1, so level 2
    expect(batches[2].map((s) => s.id).sort()).toEqual(["c", "d"]);
  });
});
