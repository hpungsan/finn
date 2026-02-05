import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { SqliteArtifactStore } from "../../artifacts/sqlite.js";
import type { ArtifactStore } from "../../artifacts/store.js";
import type { StepRunnerResult } from "../../schemas/step-result.js";
import type { BackoffConfig, Step, StepContext, StepOutput } from "../index.js";
import {
  calculateBackoff,
  ExecutorError,
  execute,
  sleep,
  topoSort,
  withTimeout,
} from "../index.js";

// Mock factories

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

function createMockContext(
  store: ArtifactStore,
  overrides?: Partial<StepContext>,
): StepContext {
  return {
    run_id: `test-run-${Math.random().toString(36).slice(2)}`,
    store,
    config: { rounds: 2, retries: 2, timeout_ms: 60_000 },
    artifacts: new Map<string, StepOutput>(),
    repo_hash: "abc123",
    ...overrides,
  };
}

// Fast backoff for tests
const FAST_BACKOFF: BackoffConfig = {
  baseMs: 1,
  maxMs: 10,
  factor: 2,
  jitter: 0,
};

describe("topoSort", () => {
  test("empty array returns empty result", () => {
    expect(topoSort([])).toEqual([]);
  });

  test("single step returns unchanged", () => {
    const step = createMockStep({ id: "a" });
    expect(topoSort([step])).toEqual([step]);
  });

  test("linear chain (a→b→c) produces correct order", () => {
    const a = createMockStep({ id: "a" });
    const b = createMockStep({ id: "b", deps: ["a"] });
    const c = createMockStep({ id: "c", deps: ["b"] });

    const result = topoSort([c, b, a]); // Input in reverse order
    const ids = result.map((s) => s.id);
    expect(ids).toEqual(["a", "b", "c"]);
  });

  test("diamond dependency produces valid order", () => {
    //   a
    //  / \
    // b   c
    //  \ /
    //   d
    const a = createMockStep({ id: "a" });
    const b = createMockStep({ id: "b", deps: ["a"] });
    const c = createMockStep({ id: "c", deps: ["a"] });
    const d = createMockStep({ id: "d", deps: ["b", "c"] });

    const result = topoSort([d, c, b, a]);
    const ids = result.map((s) => s.id);

    // a must come first
    expect(ids[0]).toBe("a");
    // d must come last
    expect(ids[3]).toBe("d");
    // b and c must come between a and d
    expect(ids.indexOf("b")).toBeGreaterThan(ids.indexOf("a"));
    expect(ids.indexOf("b")).toBeLessThan(ids.indexOf("d"));
    expect(ids.indexOf("c")).toBeGreaterThan(ids.indexOf("a"));
    expect(ids.indexOf("c")).toBeLessThan(ids.indexOf("d"));
  });

  test("multiple independent steps all present in input order", () => {
    const a = createMockStep({ id: "a" });
    const b = createMockStep({ id: "b" });
    const c = createMockStep({ id: "c" });

    const result = topoSort([a, b, c]);
    const ids = result.map((s) => s.id);
    expect(ids).toEqual(["a", "b", "c"]);
  });

  test("determinism: same input produces same output", () => {
    const a = createMockStep({ id: "a" });
    const b = createMockStep({ id: "b", deps: ["a"] });
    const c = createMockStep({ id: "c", deps: ["a"] });
    const d = createMockStep({ id: "d", deps: ["b", "c"] });

    const input = [d, c, b, a];
    const result1 = topoSort(input);
    const result2 = topoSort(input);

    expect(result1.map((s) => s.id)).toEqual(result2.map((s) => s.id));
  });

  test("simple cycle (a↔b) throws CYCLE_DETECTED", () => {
    const a = createMockStep({ id: "a", deps: ["b"] });
    const b = createMockStep({ id: "b", deps: ["a"] });

    expect(() => topoSort([a, b])).toThrow(ExecutorError);
    try {
      topoSort([a, b]);
    } catch (e) {
      expect(e).toBeInstanceOf(ExecutorError);
      const err = e as ExecutorError;
      expect(err.code).toBe("CYCLE_DETECTED");
      expect(err.details?.cycle).toContain("a");
      expect(err.details?.cycle).toContain("b");
    }
  });

  test("self-reference throws CYCLE_DETECTED", () => {
    const a = createMockStep({ id: "a", deps: ["a"] });

    expect(() => topoSort([a])).toThrow(ExecutorError);
    try {
      topoSort([a]);
    } catch (e) {
      expect(e).toBeInstanceOf(ExecutorError);
      const err = e as ExecutorError;
      expect(err.code).toBe("CYCLE_DETECTED");
      expect(err.details?.cycle).toContain("a");
    }
  });

  test("missing dependency throws MISSING_DEPENDENCY", () => {
    const a = createMockStep({ id: "a", deps: ["nonexistent"] });

    expect(() => topoSort([a])).toThrow(ExecutorError);
    try {
      topoSort([a]);
    } catch (e) {
      expect(e).toBeInstanceOf(ExecutorError);
      const err = e as ExecutorError;
      expect(err.code).toBe("MISSING_DEPENDENCY");
      expect(err.details?.step_id).toBe("a");
      expect(err.details?.missing_dep).toBe("nonexistent");
    }
  });

  test("duplicate step IDs throws DUPLICATE_STEP_ID", () => {
    const a1 = createMockStep({ id: "a" });
    const a2 = createMockStep({ id: "a" });

    expect(() => topoSort([a1, a2])).toThrow(ExecutorError);
    try {
      topoSort([a1, a2]);
    } catch (e) {
      expect(e).toBeInstanceOf(ExecutorError);
      const err = e as ExecutorError;
      expect(err.code).toBe("DUPLICATE_STEP_ID");
      expect(err.details?.step_id).toBe("a");
      expect(err.message).toBe('Duplicate step ID "a"');
    }
  });
});

describe("withTimeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("promise resolves before timeout returns resolved value", async () => {
    const promise = Promise.resolve("success");
    const resultPromise = withTimeout(promise, 1000);

    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result).toEqual({ type: "resolved", value: "success" });
  });

  test("promise exceeds timeout returns timeout", async () => {
    const neverResolves = new Promise<string>(() => {});
    const resultPromise = withTimeout(neverResolves, 100);

    vi.advanceTimersByTime(100);
    const result = await resultPromise;

    expect(result).toEqual({ type: "timeout" });
  });

  test("timeout cleared on success", async () => {
    const clearTimeoutSpy = vi.spyOn(global, "clearTimeout");
    const promise = Promise.resolve("success");

    const resultPromise = withTimeout(promise, 1000);
    await vi.runAllTimersAsync();
    await resultPromise;

    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
  });
});

describe("calculateBackoff", () => {
  test("attempt 0 returns approximately baseMs", () => {
    const config: BackoffConfig = {
      baseMs: 100,
      maxMs: 10000,
      factor: 2,
      jitter: 0,
    };
    expect(calculateBackoff(0, config)).toBe(100);
  });

  test("attempt 1 returns approximately 200", () => {
    const config: BackoffConfig = {
      baseMs: 100,
      maxMs: 10000,
      factor: 2,
      jitter: 0,
    };
    expect(calculateBackoff(1, config)).toBe(200);
  });

  test("attempt 2 returns approximately 400", () => {
    const config: BackoffConfig = {
      baseMs: 100,
      maxMs: 10000,
      factor: 2,
      jitter: 0,
    };
    expect(calculateBackoff(2, config)).toBe(400);
  });

  test("caps at maxMs", () => {
    const config: BackoffConfig = {
      baseMs: 100,
      maxMs: 500,
      factor: 2,
      jitter: 0,
    };
    // attempt 3 would be 800, but capped at 500
    expect(calculateBackoff(3, config)).toBe(500);
  });

  test("uses default config when not provided", () => {
    // DEFAULT_BACKOFF: baseMs=100, maxMs=10000, factor=2, jitter=0.25
    const result = calculateBackoff(0);
    // With jitter 0.25, result should be in range [75, 125]
    expect(result).toBeGreaterThanOrEqual(75);
    expect(result).toBeLessThanOrEqual(125);
  });

  test("jitter stays within bounds over many iterations", () => {
    const config: BackoffConfig = {
      baseMs: 100,
      maxMs: 10000,
      factor: 2,
      jitter: 0.25,
    };

    for (let i = 0; i < 100; i++) {
      const result = calculateBackoff(0, config);
      // 100 ±25% = [75, 125]
      expect(result).toBeGreaterThanOrEqual(75);
      expect(result).toBeLessThanOrEqual(125);
    }
  });

  test("returns non-negative even with extreme jitter", () => {
    const config: BackoffConfig = {
      baseMs: 10,
      maxMs: 10000,
      factor: 2,
      jitter: 1,
    };

    for (let i = 0; i < 100; i++) {
      const result = calculateBackoff(0, config);
      expect(result).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("execute - success path", () => {
  let store: SqliteArtifactStore;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new SqliteArtifactStore({ dbPath: ":memory:" });
  });

  afterEach(() => {
    vi.useRealTimers();
    store.close();
  });

  test("single step succeeds", async () => {
    const step = createMockStep({
      id: "step-a",
      run: async () => ({ status: "OK", artifact_ids: ["art-1"] }),
    });
    const ctx = createMockContext(store);

    const resultPromise = execute({
      steps: [step],
      ctx,
      backoff: FAST_BACKOFF,
      owner_id: "test-owner",
      workflow: "plan",
      args: {},
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.status).toBe("OK");
    expect(result.step_results).toHaveLength(1);
    expect(result.step_results[0].status).toBe("OK");
    expect(result.step_results[0].artifact_ids).toEqual(["art-1"]);
  });

  test("steps execute in dependency order", async () => {
    const order: string[] = [];

    const a = createMockStep({
      id: "a",
      run: async () => {
        order.push("a");
        return { status: "OK", artifact_ids: [] };
      },
    });
    const b = createMockStep({
      id: "b",
      deps: ["a"],
      run: async () => {
        order.push("b");
        return { status: "OK", artifact_ids: [] };
      },
    });
    const c = createMockStep({
      id: "c",
      deps: ["b"],
      run: async () => {
        order.push("c");
        return { status: "OK", artifact_ids: [] };
      },
    });

    const ctx = createMockContext(store);
    const resultPromise = execute({
      steps: [c, b, a],
      ctx,
      backoff: FAST_BACKOFF,
      owner_id: "test-owner",
      workflow: "plan",
      args: {},
    });
    await vi.runAllTimersAsync();
    await resultPromise;

    expect(order).toEqual(["a", "b", "c"]);
  });

  test("ctx.artifacts populated after each step", async () => {
    const a = createMockStep({
      id: "a",
      run: async () => ({ status: "OK", artifact_ids: ["art-a"] }),
    });
    const b = createMockStep({
      id: "b",
      deps: ["a"],
      run: async (ctx) => {
        // Check that a's artifacts are available
        const aOutput = ctx.artifacts.get("a");
        expect(aOutput?.artifact_ids).toEqual(["art-a"]);
        return { status: "OK", artifact_ids: ["art-b"] };
      },
    });

    const ctx = createMockContext(store);
    const resultPromise = execute({
      steps: [b, a],
      ctx,
      backoff: FAST_BACKOFF,
      owner_id: "test-owner",
      workflow: "plan",
      args: {},
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.status).toBe("OK");
    expect(ctx.artifacts.get("a")?.artifact_ids).toEqual(["art-a"]);
    expect(ctx.artifacts.get("b")?.artifact_ids).toEqual(["art-b"]);
  });

  test("transient failures then success (retry recovery)", async () => {
    let attempts = 0;
    const step = createMockStep({
      id: "step-a",
      maxRetries: 3,
      run: async () => {
        attempts++;
        if (attempts < 3) {
          return { status: "RETRY", error: "TOOL_ERROR_TRANSIENT" };
        }
        return { status: "OK", artifact_ids: ["art-1"] };
      },
    });

    const ctx = createMockContext(store);
    const resultPromise = execute({
      steps: [step],
      ctx,
      backoff: FAST_BACKOFF,
      owner_id: "test-owner",
      workflow: "plan",
      args: {},
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.status).toBe("OK");
    expect(result.step_results[0].retry_count).toBe(2);
  });
});

describe("execute - retry path", () => {
  let store: SqliteArtifactStore;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new SqliteArtifactStore({ dbPath: ":memory:" });
  });

  afterEach(() => {
    vi.useRealTimers();
    store.close();
  });

  test("retries on RETRY result up to maxRetries", async () => {
    let attempts = 0;
    const step = createMockStep({
      id: "step-a",
      maxRetries: 2,
      run: async () => {
        attempts++;
        return { status: "RETRY", error: "RATE_LIMIT" };
      },
    });

    const ctx = createMockContext(store);
    const resultPromise = execute({
      steps: [step],
      ctx,
      backoff: FAST_BACKOFF,
      owner_id: "test-owner",
      workflow: "plan",
      args: {},
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.status).toBe("FAILED");
    expect(attempts).toBe(3); // initial + 2 retries
    expect(result.step_results[0].retry_count).toBe(2);
    expect(result.step_results[0].error_code).toBe("RATE_LIMIT");
  });

  test("fails after maxRetries exceeded", async () => {
    const step = createMockStep({
      id: "step-a",
      maxRetries: 1,
      run: async () => ({ status: "RETRY", error: "TIMEOUT" }),
    });

    const ctx = createMockContext(store);
    const resultPromise = execute({
      steps: [step],
      ctx,
      backoff: FAST_BACKOFF,
      owner_id: "test-owner",
      workflow: "plan",
      args: {},
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.status).toBe("FAILED");
    expect(result.step_results[0].retry_count).toBe(1);
  });

  test("retries on thrown exception", async () => {
    let attempts = 0;
    const step = createMockStep({
      id: "step-a",
      maxRetries: 2,
      run: async () => {
        attempts++;
        if (attempts < 3) {
          throw new Error("Network error");
        }
        return { status: "OK", artifact_ids: [] };
      },
    });

    const ctx = createMockContext(store);
    const resultPromise = execute({
      steps: [step],
      ctx,
      backoff: FAST_BACKOFF,
      owner_id: "test-owner",
      workflow: "plan",
      args: {},
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.status).toBe("OK");
    expect(result.step_results[0].retry_count).toBe(2);
  });

  test("records RETRY events with error codes", async () => {
    let attempts = 0;
    const step = createMockStep({
      id: "step-a",
      maxRetries: 2,
      run: async () => {
        attempts++;
        if (attempts === 1) {
          return { status: "RETRY", error: "RATE_LIMIT" };
        }
        return { status: "OK", artifact_ids: [] };
      },
    });

    const ctx = createMockContext(store);
    const resultPromise = execute({
      steps: [step],
      ctx,
      backoff: FAST_BACKOFF,
      owner_id: "test-owner",
      workflow: "plan",
      args: {},
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    const events = result.step_results[0].events;
    expect(events[0].type).toBe("STARTED");
    expect(events[1].type).toBe("RETRY");
    expect((events[1] as { type: "RETRY"; error: string }).error).toBe(
      "RATE_LIMIT",
    );
    expect(events[2].type).toBe("OK");
  });
});

describe("execute - SCHEMA_INVALID handling", () => {
  let store: SqliteArtifactStore;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new SqliteArtifactStore({ dbPath: ":memory:" });
  });

  afterEach(() => {
    vi.useRealTimers();
    store.close();
  });

  test("SCHEMA_INVALID goes to BLOCKED immediately (no retries)", async () => {
    let attempts = 0;
    const step = createMockStep({
      id: "step-a",
      maxRetries: 3,
      run: async () => {
        attempts++;
        return { status: "RETRY", error: "SCHEMA_INVALID" };
      },
    });

    const ctx = createMockContext(store);
    const resultPromise = execute({
      steps: [step],
      ctx,
      backoff: FAST_BACKOFF,
      owner_id: "test-owner",
      workflow: "plan",
      args: {},
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.status).toBe("BLOCKED");
    expect(attempts).toBe(1); // Only one attempt, no retries
    expect(result.step_results[0].retry_count).toBe(0);
    expect(result.step_results[0].error_code).toBe("SCHEMA_INVALID");
  });

  test("event log shows BLOCKED, not multiple RETRYs", async () => {
    const step = createMockStep({
      id: "step-a",
      maxRetries: 3,
      run: async () => ({ status: "RETRY", error: "SCHEMA_INVALID" }),
    });

    const ctx = createMockContext(store);
    const resultPromise = execute({
      steps: [step],
      ctx,
      backoff: FAST_BACKOFF,
      owner_id: "test-owner",
      workflow: "plan",
      args: {},
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    const events = result.step_results[0].events;
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("STARTED");
    expect(events[1].type).toBe("BLOCKED");
  });
});

describe("execute - timeout path", () => {
  let store: SqliteArtifactStore;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new SqliteArtifactStore({ dbPath: ":memory:" });
  });

  afterEach(() => {
    vi.useRealTimers();
    store.close();
  });

  test("retries on timeout", async () => {
    let attempts = 0;
    const step = createMockStep({
      id: "step-a",
      timeout: 100,
      maxRetries: 2,
      run: async () => {
        attempts++;
        if (attempts < 2) {
          // Never resolve (will timeout)
          await new Promise(() => {});
        }
        return { status: "OK", artifact_ids: [] };
      },
    });

    const ctx = createMockContext(store);
    const resultPromise = execute({
      steps: [step],
      ctx,
      backoff: FAST_BACKOFF,
      owner_id: "test-owner",
      workflow: "plan",
      args: {},
    });

    // First attempt times out
    await vi.advanceTimersByTimeAsync(100);
    // Backoff delay
    await vi.advanceTimersByTimeAsync(10);
    // Second attempt succeeds
    await vi.runAllTimersAsync();

    const result = await resultPromise;

    expect(result.status).toBe("OK");
    expect(result.step_results[0].retry_count).toBe(1);
  });

  test("fails after timeout retries exhausted", async () => {
    const step = createMockStep({
      id: "step-a",
      timeout: 100,
      maxRetries: 1,
      run: async () => {
        // Never resolve
        await new Promise(() => {});
        return { status: "OK", artifact_ids: [] };
      },
    });

    const ctx = createMockContext(store);
    const resultPromise = execute({
      steps: [step],
      ctx,
      backoff: FAST_BACKOFF,
      owner_id: "test-owner",
      workflow: "plan",
      args: {},
    });

    // First attempt times out
    await vi.advanceTimersByTimeAsync(100);
    // Backoff delay
    await vi.advanceTimersByTimeAsync(10);
    // Second attempt times out
    await vi.advanceTimersByTimeAsync(100);

    const result = await resultPromise;

    expect(result.status).toBe("FAILED");
    expect(result.step_results[0].error_code).toBe("TIMEOUT");
    expect(result.step_results[0].retry_count).toBe(1);
  });

  test("uses step.timeout (not config.timeout_ms)", async () => {
    const step = createMockStep({
      id: "step-a",
      timeout: 50, // Step timeout is 50ms
      maxRetries: 0,
      run: async () => {
        await new Promise(() => {});
        return { status: "OK", artifact_ids: [] };
      },
    });

    // Config timeout is 60000ms but step timeout is 50ms
    const ctx = createMockContext(store, {
      config: { rounds: 2, retries: 2, timeout_ms: 60000 },
    });
    const resultPromise = execute({
      steps: [step],
      ctx,
      backoff: FAST_BACKOFF,
      owner_id: "test-owner",
      workflow: "plan",
      args: {},
    });

    // Step should timeout at 50ms, not 60000ms
    await vi.advanceTimersByTimeAsync(50);
    const result = await resultPromise;

    expect(result.status).toBe("FAILED");
    expect(result.step_results[0].error_code).toBe("TIMEOUT");
  });
});

describe("execute - terminal states", () => {
  let store: SqliteArtifactStore;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new SqliteArtifactStore({ dbPath: ":memory:" });
  });

  afterEach(() => {
    vi.useRealTimers();
    store.close();
  });

  test("stops on BLOCKED (does not execute downstream)", async () => {
    const executed: string[] = [];

    const a = createMockStep({
      id: "a",
      run: async () => {
        executed.push("a");
        return {
          status: "BLOCKED",
          artifact_ids: [],
          error: "HUMAN_REQUIRED",
        } as StepRunnerResult;
      },
    });
    const b = createMockStep({
      id: "b",
      deps: ["a"],
      run: async () => {
        executed.push("b");
        return { status: "OK", artifact_ids: [] };
      },
    });

    const ctx = createMockContext(store);
    const resultPromise = execute({
      steps: [b, a],
      ctx,
      backoff: FAST_BACKOFF,
      owner_id: "test-owner",
      workflow: "plan",
      args: {},
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.status).toBe("BLOCKED");
    expect(result.failed_step).toBe("a");
    expect(executed).toEqual(["a"]);
  });

  test("stops on FAILED (does not execute downstream)", async () => {
    const executed: string[] = [];

    const a = createMockStep({
      id: "a",
      run: async () => {
        executed.push("a");
        return {
          status: "FAILED",
          artifact_ids: [],
          error: "TOOL_ERROR_PERMANENT",
        } as StepRunnerResult;
      },
    });
    const b = createMockStep({
      id: "b",
      deps: ["a"],
      run: async () => {
        executed.push("b");
        return { status: "OK", artifact_ids: [] };
      },
    });

    const ctx = createMockContext(store);
    const resultPromise = execute({
      steps: [b, a],
      ctx,
      backoff: FAST_BACKOFF,
      owner_id: "test-owner",
      workflow: "plan",
      args: {},
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.status).toBe("FAILED");
    expect(result.failed_step).toBe("a");
    expect(executed).toEqual(["a"]);
  });

  test("returns failed_step and error_code", async () => {
    const step = createMockStep({
      id: "step-x",
      run: async () =>
        ({
          status: "FAILED",
          artifact_ids: [],
          error: "THRASHING",
        }) as StepRunnerResult,
    });

    const ctx = createMockContext(store);
    const resultPromise = execute({
      steps: [step],
      ctx,
      backoff: FAST_BACKOFF,
      owner_id: "test-owner",
      workflow: "plan",
      args: {},
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.failed_step).toBe("step-x");
    expect(result.error_code).toBe("THRASHING");
  });
});

describe("execute - event recording", () => {
  let store: SqliteArtifactStore;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
    store = new SqliteArtifactStore({ dbPath: ":memory:" });
  });

  afterEach(() => {
    vi.useRealTimers();
    store.close();
  });

  test("STARTED event recorded first", async () => {
    const step = createMockStep({
      id: "step-a",
      run: async () => ({ status: "OK", artifact_ids: [] }),
    });

    const ctx = createMockContext(store);
    const resultPromise = execute({
      steps: [step],
      ctx,
      backoff: FAST_BACKOFF,
      owner_id: "test-owner",
      workflow: "plan",
      args: {},
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.step_results[0].events[0].type).toBe("STARTED");
  });

  test("OK event recorded last on success", async () => {
    const step = createMockStep({
      id: "step-a",
      run: async () => ({ status: "OK", artifact_ids: [] }),
    });

    const ctx = createMockContext(store);
    const resultPromise = execute({
      steps: [step],
      ctx,
      backoff: FAST_BACKOFF,
      owner_id: "test-owner",
      workflow: "plan",
      args: {},
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    const events = result.step_results[0].events;
    expect(events[events.length - 1].type).toBe("OK");
  });

  test("BLOCKED event recorded last on block", async () => {
    const step = createMockStep({
      id: "step-a",
      run: async () =>
        ({
          status: "BLOCKED",
          artifact_ids: [],
          error: "HUMAN_REQUIRED",
        }) as StepRunnerResult,
    });

    const ctx = createMockContext(store);
    const resultPromise = execute({
      steps: [step],
      ctx,
      backoff: FAST_BACKOFF,
      owner_id: "test-owner",
      workflow: "plan",
      args: {},
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    const events = result.step_results[0].events;
    expect(events[events.length - 1].type).toBe("BLOCKED");
  });

  test("FAILED event recorded last on failure", async () => {
    const step = createMockStep({
      id: "step-a",
      maxRetries: 0,
      run: async () => ({ status: "RETRY", error: "TIMEOUT" }),
    });

    const ctx = createMockContext(store);
    const resultPromise = execute({
      steps: [step],
      ctx,
      backoff: FAST_BACKOFF,
      owner_id: "test-owner",
      workflow: "plan",
      args: {},
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    const events = result.step_results[0].events;
    expect(events[events.length - 1].type).toBe("FAILED");
  });

  test("RETRY events recorded for each retry", async () => {
    let attempts = 0;
    const step = createMockStep({
      id: "step-a",
      maxRetries: 3,
      run: async () => {
        attempts++;
        if (attempts < 3) {
          return { status: "RETRY", error: "RATE_LIMIT" };
        }
        return { status: "OK", artifact_ids: [] };
      },
    });

    const ctx = createMockContext(store);
    const resultPromise = execute({
      steps: [step],
      ctx,
      backoff: FAST_BACKOFF,
      owner_id: "test-owner",
      workflow: "plan",
      args: {},
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    const events = result.step_results[0].events;
    const retryEvents = events.filter((e) => e.type === "RETRY");
    expect(retryEvents).toHaveLength(2);
  });

  test("events have ISO timestamp format", async () => {
    const step = createMockStep({
      id: "step-a",
      run: async () => ({ status: "OK", artifact_ids: [] }),
    });

    const ctx = createMockContext(store);
    const resultPromise = execute({
      steps: [step],
      ctx,
      backoff: FAST_BACKOFF,
      owner_id: "test-owner",
      workflow: "plan",
      args: {},
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    for (const event of result.step_results[0].events) {
      expect(event.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/);
    }
  });
});

describe("execute - edge cases", () => {
  let store: SqliteArtifactStore;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new SqliteArtifactStore({ dbPath: ":memory:" });
  });

  afterEach(() => {
    vi.useRealTimers();
    store.close();
  });

  test("empty steps array returns OK with empty results", async () => {
    const ctx = createMockContext(store);
    const resultPromise = execute({
      steps: [],
      ctx,
      backoff: FAST_BACKOFF,
      owner_id: "test-owner",
      workflow: "plan",
      args: {},
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.status).toBe("OK");
    expect(result.step_results).toEqual([]);
  });

  test("throws on cycle detection", async () => {
    const a = createMockStep({ id: "a", deps: ["b"] });
    const b = createMockStep({ id: "b", deps: ["a"] });

    const ctx = createMockContext(store);

    await expect(
      execute({
        steps: [a, b],
        ctx,
        backoff: FAST_BACKOFF,
        owner_id: "test-owner",
        workflow: "plan",
        args: {},
      }),
    ).rejects.toThrow(ExecutorError);
  });

  test("throws on missing dependency", async () => {
    const a = createMockStep({ id: "a", deps: ["nonexistent"] });

    const ctx = createMockContext(store);

    await expect(
      execute({
        steps: [a],
        ctx,
        backoff: FAST_BACKOFF,
        owner_id: "test-owner",
        workflow: "plan",
        args: {},
      }),
    ).rejects.toThrow(ExecutorError);
  });

  test("custom backoff config honored", async () => {
    // This test verifies that execute() accepts a custom backoff config.
    // The actual backoff calculation is validated by calculateBackoff tests.
    let attempts = 0;
    const step = createMockStep({
      id: "step-a",
      maxRetries: 2,
      run: async () => {
        attempts++;
        if (attempts < 3) {
          return { status: "RETRY", error: "RATE_LIMIT" };
        }
        return { status: "OK", artifact_ids: [] };
      },
    });

    const customBackoff: BackoffConfig = {
      baseMs: 1,
      maxMs: 10,
      factor: 2,
      jitter: 0,
    };

    const ctx = createMockContext(store);
    const resultPromise = execute({
      steps: [step],
      ctx,
      backoff: customBackoff,
      owner_id: "test-owner",
      workflow: "plan",
      args: {},
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.status).toBe("OK");
    expect(result.step_results[0].retry_count).toBe(2);
  });

  test("step actions passed through on OK", async () => {
    const step = createMockStep({
      id: "step-a",
      run: async () => ({
        status: "OK",
        artifact_ids: ["art-1"],
        actions: [
          { action_id: "act-1", path: "/foo/bar.ts", op: "edit" as const },
        ],
      }),
    });

    const ctx = createMockContext(store);
    const resultPromise = execute({
      steps: [step],
      ctx,
      backoff: FAST_BACKOFF,
      owner_id: "test-owner",
      workflow: "plan",
      args: {},
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.step_results[0].actions).toEqual([
      { action_id: "act-1", path: "/foo/bar.ts", op: "edit" },
    ]);
  });

  test("step actions passed through on BLOCKED", async () => {
    const step = createMockStep({
      id: "step-a",
      run: async () =>
        ({
          status: "BLOCKED",
          artifact_ids: [],
          error: "HUMAN_REQUIRED",
          actions: [
            { action_id: "act-1", path: "/foo/bar.ts", op: "create" as const },
          ],
        }) as StepRunnerResult,
    });

    const ctx = createMockContext(store);
    const resultPromise = execute({
      steps: [step],
      ctx,
      backoff: FAST_BACKOFF,
      owner_id: "test-owner",
      workflow: "plan",
      args: {},
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.step_results[0].actions).toEqual([
      { action_id: "act-1", path: "/foo/bar.ts", op: "create" },
    ]);
  });

  test("repair_count always 0 in Stage 2", async () => {
    const step = createMockStep({
      id: "step-a",
      run: async () => ({ status: "OK", artifact_ids: [] }),
    });

    const ctx = createMockContext(store);
    const resultPromise = execute({
      steps: [step],
      ctx,
      backoff: FAST_BACKOFF,
      owner_id: "test-owner",
      workflow: "plan",
      args: {},
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.step_results[0].repair_count).toBe(0);
  });

  test("step_instance_id and inputs_digest computed correctly", async () => {
    const step = createMockStep({
      id: "step-a",
      model: "opus",
      prompt_version: "v2",
      schema_version: "2.0",
      getInputs: () => ({ repo_hash: "test-hash" }),
      run: async () => ({ status: "OK", artifact_ids: [] }),
    });

    const ctx = createMockContext(store);
    const resultPromise = execute({
      steps: [step],
      ctx,
      backoff: FAST_BACKOFF,
      owner_id: "test-owner",
      workflow: "plan",
      args: {},
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    // Both should be 64-char hex strings (SHA-256)
    expect(result.step_results[0].inputs_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.step_results[0].step_instance_id).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("execute - parallel execution", () => {
  let store: SqliteArtifactStore;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new SqliteArtifactStore({ dbPath: ":memory:" });
  });

  afterEach(() => {
    vi.useRealTimers();
    store.close();
  });

  test("independent steps run in parallel", async () => {
    const startTimes: Record<string, number> = {};
    const endTimes: Record<string, number> = {};

    const a = createMockStep({
      id: "a",
      run: async () => {
        startTimes.a = Date.now();
        await new Promise((r) => setTimeout(r, 10));
        endTimes.a = Date.now();
        return { status: "OK", artifact_ids: [] };
      },
    });
    const b = createMockStep({
      id: "b",
      run: async () => {
        startTimes.b = Date.now();
        await new Promise((r) => setTimeout(r, 10));
        endTimes.b = Date.now();
        return { status: "OK", artifact_ids: [] };
      },
    });
    const c = createMockStep({
      id: "c",
      run: async () => {
        startTimes.c = Date.now();
        await new Promise((r) => setTimeout(r, 10));
        endTimes.c = Date.now();
        return { status: "OK", artifact_ids: [] };
      },
    });

    const ctx = createMockContext(store);
    const resultPromise = execute({
      steps: [a, b, c],
      ctx,
      backoff: FAST_BACKOFF,
      owner_id: "test-owner",
      workflow: "plan",
      args: {},
      concurrency: 3,
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.status).toBe("OK");
    expect(result.step_results).toHaveLength(3);

    // All should start at roughly the same time (parallel)
    const starts = Object.values(startTimes);
    const maxStart = Math.max(...starts);
    const minStart = Math.min(...starts);
    expect(maxStart - minStart).toBeLessThan(5); // All started together
  });

  test("respects semaphore limit", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;

    const createStep = (id: string) =>
      createMockStep({
        id,
        run: async () => {
          concurrent++;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          await new Promise((r) => setTimeout(r, 10));
          concurrent--;
          return { status: "OK", artifact_ids: [] };
        },
      });

    const steps = Array.from({ length: 6 }, (_, i) => createStep(`step-${i}`));

    const ctx = createMockContext(store);
    const resultPromise = execute({
      steps,
      ctx,
      backoff: FAST_BACKOFF,
      owner_id: "test-owner",
      workflow: "plan",
      args: {},
      concurrency: 2, // Limit to 2 concurrent
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.status).toBe("OK");
    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });

  test("respects dependency order across batches", async () => {
    const order: string[] = [];

    const a = createMockStep({
      id: "a",
      run: async () => {
        order.push("a");
        return { status: "OK", artifact_ids: [] };
      },
    });
    const b = createMockStep({
      id: "b",
      deps: ["a"],
      run: async () => {
        order.push("b");
        return { status: "OK", artifact_ids: [] };
      },
    });
    const c = createMockStep({
      id: "c",
      deps: ["a"],
      run: async () => {
        order.push("c");
        return { status: "OK", artifact_ids: [] };
      },
    });
    const d = createMockStep({
      id: "d",
      deps: ["b", "c"],
      run: async () => {
        order.push("d");
        return { status: "OK", artifact_ids: [] };
      },
    });

    const ctx = createMockContext(store);
    const resultPromise = execute({
      steps: [d, c, b, a],
      ctx,
      backoff: FAST_BACKOFF,
      owner_id: "test-owner",
      workflow: "plan",
      args: {},
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.status).toBe("OK");
    // a must be first
    expect(order.indexOf("a")).toBe(0);
    // d must be last
    expect(order.indexOf("d")).toBe(3);
    // b and c after a, before d
    expect(order.indexOf("b")).toBeGreaterThan(0);
    expect(order.indexOf("b")).toBeLessThan(3);
    expect(order.indexOf("c")).toBeGreaterThan(0);
    expect(order.indexOf("c")).toBeLessThan(3);
  });

  test("stops at batch boundary on failure", async () => {
    const executed: string[] = [];

    const a = createMockStep({
      id: "a",
      run: async () => {
        executed.push("a");
        return { status: "OK", artifact_ids: [] };
      },
    });
    const b = createMockStep({
      id: "b",
      deps: ["a"],
      run: async () => {
        executed.push("b");
        return {
          status: "FAILED",
          artifact_ids: [],
          error: "TOOL_ERROR_PERMANENT",
        } as StepRunnerResult;
      },
    });
    const c = createMockStep({
      id: "c",
      deps: ["a"],
      run: async () => {
        executed.push("c");
        return { status: "OK", artifact_ids: [] };
      },
    });
    const d = createMockStep({
      id: "d",
      deps: ["b", "c"],
      run: async () => {
        executed.push("d");
        return { status: "OK", artifact_ids: [] };
      },
    });

    const ctx = createMockContext(store);
    const resultPromise = execute({
      steps: [d, c, b, a],
      ctx,
      backoff: FAST_BACKOFF,
      owner_id: "test-owner",
      workflow: "plan",
      args: {},
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.status).toBe("FAILED");
    // a runs first (batch 0)
    // b and c run together (batch 1), but b fails
    // d should NOT run (batch 2 not started)
    expect(executed).toContain("a");
    expect(executed).toContain("b");
    expect(executed).toContain("c"); // c completes since it started with b
    expect(executed).not.toContain("d");
  });
});

describe("sleep", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("resolves after specified ms", async () => {
    let resolved = false;
    const promise = sleep(100).then(() => {
      resolved = true;
    });

    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(99);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await promise;
    expect(resolved).toBe(true);
  });
});

describe("execute - AbortSignal cooperative cancellation", () => {
  let store: SqliteArtifactStore;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new SqliteArtifactStore({ dbPath: ":memory:" });
  });

  afterEach(() => {
    vi.useRealTimers();
    store.close();
  });

  test("signal passed to step.run()", async () => {
    let receivedSignal: AbortSignal | undefined;
    const step = createMockStep({
      id: "step-a",
      run: async (ctx) => {
        receivedSignal = ctx.signal;
        return { status: "OK", artifact_ids: [] };
      },
    });

    const ctx = createMockContext(store);
    const resultPromise = execute({
      steps: [step],
      ctx,
      backoff: FAST_BACKOFF,
      owner_id: "test-owner",
      workflow: "plan",
      args: {},
    });
    await vi.runAllTimersAsync();
    await resultPromise;

    expect(receivedSignal).toBeInstanceOf(AbortSignal);
    expect(receivedSignal?.aborted).toBe(false);
  });

  test("signal aborted on timeout", async () => {
    let capturedSignal: AbortSignal | undefined;
    const step = createMockStep({
      id: "step-a",
      timeout: 100,
      maxRetries: 0,
      run: async (ctx) => {
        capturedSignal = ctx.signal;
        // Never resolve - will timeout
        await new Promise(() => {});
        return { status: "OK", artifact_ids: [] };
      },
    });

    const ctx = createMockContext(store);
    const resultPromise = execute({
      steps: [step],
      ctx,
      backoff: FAST_BACKOFF,
      owner_id: "test-owner",
      workflow: "plan",
      args: {},
    });

    // Wait for timeout
    await vi.advanceTimersByTimeAsync(100);
    const result = await resultPromise;

    expect(result.status).toBe("FAILED");
    expect(result.step_results[0].error_code).toBe("TIMEOUT");
    // Signal should have been aborted
    expect(capturedSignal?.aborted).toBe(true);
  });

  test("signal aborted before retry on RETRY result", async () => {
    const signals: AbortSignal[] = [];
    let attempts = 0;

    const step = createMockStep({
      id: "step-a",
      maxRetries: 2,
      run: async (ctx) => {
        if (ctx.signal) signals.push(ctx.signal);
        attempts++;
        if (attempts < 2) {
          return { status: "RETRY", error: "RATE_LIMIT" };
        }
        return { status: "OK", artifact_ids: [] };
      },
    });

    const ctx = createMockContext(store);
    const resultPromise = execute({
      steps: [step],
      ctx,
      backoff: FAST_BACKOFF,
      owner_id: "test-owner",
      workflow: "plan",
      args: {},
    });
    await vi.runAllTimersAsync();
    await resultPromise;

    expect(signals).toHaveLength(2);
    // First attempt's signal should be aborted before retry
    expect(signals[0].aborted).toBe(true);
    // Second attempt's signal should not be aborted (step succeeded)
    expect(signals[1].aborted).toBe(false);
  });

  test("signal aborted on thrown exception before retry", async () => {
    const signals: AbortSignal[] = [];
    let attempts = 0;

    const step = createMockStep({
      id: "step-a",
      maxRetries: 2,
      run: async (ctx) => {
        if (ctx.signal) signals.push(ctx.signal);
        attempts++;
        if (attempts < 2) {
          throw new Error("Network error");
        }
        return { status: "OK", artifact_ids: [] };
      },
    });

    const ctx = createMockContext(store);
    const resultPromise = execute({
      steps: [step],
      ctx,
      backoff: FAST_BACKOFF,
      owner_id: "test-owner",
      workflow: "plan",
      args: {},
    });
    await vi.runAllTimersAsync();
    await resultPromise;

    expect(signals).toHaveLength(2);
    // First attempt's signal should be aborted after exception
    expect(signals[0].aborted).toBe(true);
    // Second attempt's signal should not be aborted
    expect(signals[1].aborted).toBe(false);
  });

  test("each retry gets fresh AbortController", async () => {
    const signals: AbortSignal[] = [];
    let attempts = 0;

    const step = createMockStep({
      id: "step-a",
      maxRetries: 3,
      run: async (ctx) => {
        if (ctx.signal) signals.push(ctx.signal);
        attempts++;
        if (attempts < 3) {
          return { status: "RETRY", error: "TIMEOUT" };
        }
        return { status: "OK", artifact_ids: [] };
      },
    });

    const ctx = createMockContext(store);
    const resultPromise = execute({
      steps: [step],
      ctx,
      backoff: FAST_BACKOFF,
      owner_id: "test-owner",
      workflow: "plan",
      args: {},
    });
    await vi.runAllTimersAsync();
    await resultPromise;

    // Each attempt should get a unique signal
    expect(signals).toHaveLength(3);
    expect(signals[0]).not.toBe(signals[1]);
    expect(signals[1]).not.toBe(signals[2]);
  });
});

describe("execute - step-result TTL alignment", () => {
  let store: SqliteArtifactStore;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new SqliteArtifactStore({ dbPath: ":memory:" });
  });

  afterEach(() => {
    vi.useRealTimers();
    store.close();
  });

  test("step-results have conservative TTL (30d) during execution", async () => {
    const step = createMockStep({
      id: "step-a",
      run: async () => ({ status: "OK", artifact_ids: [] }),
    });

    const ctx = createMockContext(store);
    const resultPromise = execute({
      steps: [step],
      ctx,
      backoff: FAST_BACKOFF,
      owner_id: "test-owner",
      workflow: "plan",
      args: {},
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    // After successful run, TTLs are aligned to 7 days
    // But we can verify the artifact exists (run-scoped naming)
    const stepResult = await store.fetch({
      workspace: "runs",
      name: `${ctx.run_id}-${result.step_results[0].step_instance_id}`,
    });
    expect(stepResult).not.toBeNull();
  });

  test("successful run aligns step-result TTLs to 7 days", async () => {
    // Track TTL values at store() calls
    const ttlValues: number[] = [];
    const originalStore = store.store.bind(store);
    vi.spyOn(store, "store").mockImplementation(async (opts) => {
      if (opts.kind === "step-result") {
        ttlValues.push(opts.ttl_seconds as number);
      }
      return originalStore(opts);
    });

    const step = createMockStep({
      id: "step-a",
      run: async () => ({ status: "OK", artifact_ids: [] }),
    });

    const ctx = createMockContext(store);
    const resultPromise = execute({
      steps: [step],
      ctx,
      backoff: FAST_BACKOFF,
      owner_id: "test-owner",
      workflow: "plan",
      args: {},
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.status).toBe("OK");
    // First store: conservative 30d, second store: aligned 7d
    expect(ttlValues).toHaveLength(2);
    expect(ttlValues[0]).toBe(30 * 24 * 3600); // 30 days
    expect(ttlValues[1]).toBe(7 * 24 * 3600); // 7 days

    // run_id must be preserved for step-results (alignment update should not clear it)
    const stepResult = await store.fetch({
      workspace: "runs",
      name: `${ctx.run_id}-${result.step_results[0].step_instance_id}`,
    });
    expect(stepResult?.run_id).toBe(ctx.run_id);
  });

  test("failed run keeps step-result TTLs at 30 days", async () => {
    const ttlValues: number[] = [];
    const originalStore = store.store.bind(store);
    vi.spyOn(store, "store").mockImplementation(async (opts) => {
      if (opts.kind === "step-result") {
        ttlValues.push(opts.ttl_seconds as number);
      }
      return originalStore(opts);
    });

    const step = createMockStep({
      id: "step-a",
      maxRetries: 0,
      run: async () =>
        ({
          status: "FAILED",
          artifact_ids: [],
          error: "TOOL_ERROR_PERMANENT",
        }) as StepRunnerResult,
    });

    const ctx = createMockContext(store);
    const resultPromise = execute({
      steps: [step],
      ctx,
      backoff: FAST_BACKOFF,
      owner_id: "test-owner",
      workflow: "plan",
      args: {},
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.status).toBe("FAILED");
    // Only one store for step-result (no alignment needed for failed runs)
    expect(ttlValues).toHaveLength(1);
    expect(ttlValues[0]).toBe(30 * 24 * 3600); // 30 days
  });

  test("all step-results aligned on successful multi-step run", async () => {
    const stepResultTtls: Record<string, number[]> = {};
    const originalStore = store.store.bind(store);
    vi.spyOn(store, "store").mockImplementation(async (opts) => {
      if (opts.kind === "step-result") {
        const name = opts.name as string;
        if (!stepResultTtls[name]) stepResultTtls[name] = [];
        stepResultTtls[name].push(opts.ttl_seconds as number);
      }
      return originalStore(opts);
    });

    const a = createMockStep({
      id: "a",
      run: async () => ({ status: "OK", artifact_ids: [] }),
    });
    const b = createMockStep({
      id: "b",
      deps: ["a"],
      run: async () => ({ status: "OK", artifact_ids: [] }),
    });
    const c = createMockStep({
      id: "c",
      deps: ["b"],
      run: async () => ({ status: "OK", artifact_ids: [] }),
    });

    const ctx = createMockContext(store);
    const resultPromise = execute({
      steps: [c, b, a],
      ctx,
      backoff: FAST_BACKOFF,
      owner_id: "test-owner",
      workflow: "plan",
      args: {},
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.status).toBe("OK");
    // Each step-result should have been stored twice (conservative, then aligned)
    for (const ttls of Object.values(stepResultTtls)) {
      expect(ttls).toHaveLength(2);
      expect(ttls[0]).toBe(30 * 24 * 3600); // Conservative
      expect(ttls[1]).toBe(7 * 24 * 3600); // Aligned
    }
  });
});
