import type {
  ErrorCode,
  StepAction,
  StepEvent,
} from "../schemas/run-record.js";
import type { StepRunnerResult } from "../schemas/step-result.js";
import { ExecutorError } from "./errors.js";
import { computeStepIdempotency } from "./idempotency.js";
import type { Step, StepContext } from "./types.js";

export interface ExecuteOpts {
  steps: Step[];
  ctx: StepContext;
  backoff?: BackoffConfig;
}

export interface StepExecutionResult {
  step_id: string;
  step_instance_id: string;
  inputs_digest: string;
  status: "OK" | "BLOCKED" | "FAILED";
  events: StepEvent[];
  artifact_ids: string[];
  actions?: StepAction[];
  retry_count: number;
  repair_count: number; // always 0 in Stage 2
  error_code?: ErrorCode;
}

export interface ExecuteResult {
  status: "OK" | "BLOCKED" | "FAILED";
  step_results: StepExecutionResult[];
  failed_step?: string;
  error_code?: ErrorCode;
}

export interface BackoffConfig {
  baseMs: number;
  maxMs: number;
  factor: number;
  jitter: number; // 0-1, e.g., 0.25 = ±25%
}

export const DEFAULT_BACKOFF: BackoffConfig = {
  baseMs: 100,
  maxMs: 10_000,
  factor: 2,
  jitter: 0.25,
};

/**
 * Discriminated result from withTimeout to avoid conflation with StepRunnerResult.
 * A step could legitimately return { status: "RETRY", error: "TIMEOUT" }, so we
 * need a separate type to distinguish actual timeouts from step results.
 */
export type TimeoutResult<T> =
  | { type: "resolved"; value: T }
  | { type: "timeout" };

/**
 * Topologically sort steps by dependencies using Kahn's algorithm.
 *
 * Determinism: When multiple steps have in-degree 0, they are processed
 * in input array order (Map iteration order = insertion order in ES6+).
 * Same input array → same output order.
 */
export function topoSort(steps: Step[]): Step[] {
  const stepMap = new Map<string, Step>();
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  // Initialize and check for duplicates
  for (const step of steps) {
    if (stepMap.has(step.id)) {
      throw new ExecutorError(
        "DUPLICATE_STEP_ID",
        `Duplicate step ID "${step.id}"`,
        { step_id: step.id },
      );
    }
    stepMap.set(step.id, step);
    inDegree.set(step.id, 0);
    dependents.set(step.id, []);
  }

  // Build graph, validate deps exist
  for (const step of steps) {
    for (const dep of step.deps) {
      if (!stepMap.has(dep)) {
        throw new ExecutorError(
          "MISSING_DEPENDENCY",
          `Step "${step.id}" depends on non-existent step "${dep}"`,
          { step_id: step.id, missing_dep: dep },
        );
      }
      const currentDegree = inDegree.get(step.id) ?? 0;
      inDegree.set(step.id, currentDegree + 1);
      const depList = dependents.get(dep);
      if (depList) depList.push(step.id);
    }
  }

  // Process steps with no deps
  const queue: string[] = [];
  for (const [id, degree] of inDegree) {
    if (degree === 0) queue.push(id);
  }

  const sorted: Step[] = [];
  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined) break;
    const step = stepMap.get(id);
    if (step) sorted.push(step);
    const deps = dependents.get(id) ?? [];
    for (const dependent of deps) {
      const currentDegree = inDegree.get(dependent) ?? 0;
      const newDegree = currentDegree - 1;
      inDegree.set(dependent, newDegree);
      if (newDegree === 0) queue.push(dependent);
    }
  }

  // Cycle detection
  if (sorted.length !== steps.length) {
    const cycleNodes = [...inDegree.entries()]
      .filter(([_, d]) => d > 0)
      .map(([id]) => id);
    throw new ExecutorError(
      "CYCLE_DETECTED",
      `Dependency cycle detected involving: ${cycleNodes.join(", ")}`,
      { cycle: cycleNodes },
    );
  }

  return sorted;
}

/**
 * Race a promise against a timeout.
 * Returns discriminated union to avoid conflation with step results.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<TimeoutResult<T>> {
  let timeoutId: ReturnType<typeof setTimeout>;

  const timeoutPromise = new Promise<{ type: "timeout" }>((resolve) => {
    timeoutId = setTimeout(() => {
      resolve({ type: "timeout" });
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([
      promise.then((value) => ({ type: "resolved" as const, value })),
      timeoutPromise,
    ]);
    return result;
  } finally {
    // biome-ignore lint/style/noNonNullAssertion: timeoutId is always assigned before race
    clearTimeout(timeoutId!);
  }
}

/**
 * Calculate exponential backoff with jitter.
 * Jitter prevents thundering herd when multiple steps retry simultaneously.
 */
export function calculateBackoff(
  attempt: number,
  config: BackoffConfig = DEFAULT_BACKOFF,
): number {
  const delay = config.baseMs * config.factor ** attempt;
  const capped = Math.min(delay, config.maxMs);
  // Apply jitter: ±(jitter * 100)%
  const jitterRange = capped * config.jitter;
  const jitterOffset = jitterRange * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(capped + jitterOffset));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute a single step with retry loop.
 *
 * Key points:
 * - Uses `step.timeout` directly (required field, no fallback)
 * - Uses `step.maxRetries` directly (required field, no fallback)
 * - Catches thrown exceptions, treats as TOOL_ERROR_TRANSIENT
 * - SCHEMA_INVALID → BLOCKED immediately (no retries, per FINN.md)
 * - Records events for each state transition
 */
async function runStep(
  step: Step,
  ctx: StepContext,
  backoff: BackoffConfig,
): Promise<StepExecutionResult> {
  const inputs = step.getInputs(ctx);
  const { inputs_digest, step_instance_id } = computeStepIdempotency(
    step.id,
    inputs,
    {
      model: step.model,
      prompt_version: step.prompt_version,
      schema_version: step.schema_version,
    },
  );

  const events: StepEvent[] = [];
  let retry_count = 0;

  events.push({ type: "STARTED", at: new Date().toISOString() });

  while (true) {
    let result: StepRunnerResult;

    try {
      const timeoutResult = await withTimeout(step.run(ctx), step.timeout);

      // Handle timeout
      if (timeoutResult.type === "timeout") {
        if (retry_count >= step.maxRetries) {
          events.push({ type: "FAILED", at: new Date().toISOString() });
          return {
            step_id: step.id,
            step_instance_id,
            inputs_digest,
            status: "FAILED",
            events,
            artifact_ids: [],
            retry_count,
            repair_count: 0,
            error_code: "TIMEOUT",
          };
        }
        events.push({
          type: "RETRY",
          at: new Date().toISOString(),
          error: "TIMEOUT",
        });
        retry_count++;
        await sleep(calculateBackoff(retry_count - 1, backoff));
        continue;
      }

      result = timeoutResult.value;
    } catch {
      // step.run() threw - treat as transient error
      // Note: Steps should return { status: "FAILED", error: "TOOL_ERROR_PERMANENT" }
      // for permanent errors. Throws are assumed transient (network issues, etc.)
      if (retry_count >= step.maxRetries) {
        events.push({ type: "FAILED", at: new Date().toISOString() });
        return {
          step_id: step.id,
          step_instance_id,
          inputs_digest,
          status: "FAILED",
          events,
          artifact_ids: [],
          retry_count,
          repair_count: 0,
          error_code: "TOOL_ERROR_TRANSIENT",
        };
      }
      events.push({
        type: "RETRY",
        at: new Date().toISOString(),
        error: "TOOL_ERROR_TRANSIENT",
      });
      retry_count++;
      await sleep(calculateBackoff(retry_count - 1, backoff));
      continue;
    }

    switch (result.status) {
      case "OK":
        events.push({ type: "OK", at: new Date().toISOString() });
        return {
          step_id: step.id,
          step_instance_id,
          inputs_digest,
          status: "OK",
          events,
          artifact_ids: result.artifact_ids,
          actions: result.actions,
          retry_count,
          repair_count: 0,
        };

      case "RETRY":
        // SCHEMA_INVALID: per FINN.md, only one repair attempt then BLOCKED
        // Stage 2 has no repair, so go straight to BLOCKED
        if (result.error === "SCHEMA_INVALID") {
          events.push({ type: "BLOCKED", at: new Date().toISOString() });
          return {
            step_id: step.id,
            step_instance_id,
            inputs_digest,
            status: "BLOCKED",
            events,
            artifact_ids: [],
            retry_count,
            repair_count: 0,
            error_code: "SCHEMA_INVALID",
          };
        }

        if (retry_count >= step.maxRetries) {
          events.push({ type: "FAILED", at: new Date().toISOString() });
          return {
            step_id: step.id,
            step_instance_id,
            inputs_digest,
            status: "FAILED",
            events,
            artifact_ids: [],
            retry_count,
            repair_count: 0,
            error_code: result.error,
          };
        }
        events.push({
          type: "RETRY",
          at: new Date().toISOString(),
          error: result.error,
        });
        retry_count++;
        await sleep(calculateBackoff(retry_count - 1, backoff));
        continue;

      case "BLOCKED":
        events.push({ type: "BLOCKED", at: new Date().toISOString() });
        return {
          step_id: step.id,
          step_instance_id,
          inputs_digest,
          status: "BLOCKED",
          events,
          artifact_ids: result.artifact_ids,
          actions: result.actions,
          retry_count,
          repair_count: 0,
          error_code: result.error,
        };

      case "FAILED":
        events.push({ type: "FAILED", at: new Date().toISOString() });
        return {
          step_id: step.id,
          step_instance_id,
          inputs_digest,
          status: "FAILED",
          events,
          artifact_ids: result.artifact_ids,
          actions: result.actions,
          retry_count,
          repair_count: 0,
          error_code: result.error,
        };
    }
  }
}

/**
 * Execute steps in topological order.
 *
 * Stage 2 is sequential only; Stage 3 adds parallel execution with semaphore.
 * Stops on first BLOCKED or FAILED step.
 *
 * Note: ctx.artifacts only stores `{ artifact_ids }`. Steps needing
 * `ArtifactInputRef.version` for idempotency must fetch from ctx.store.
 * Stage 3 will enhance to store `{ artifact_ids, versions }`.
 */
export async function execute(opts: ExecuteOpts): Promise<ExecuteResult> {
  const { steps, ctx, backoff = DEFAULT_BACKOFF } = opts;

  const sortedSteps = topoSort(steps);
  const step_results: StepExecutionResult[] = [];

  for (const step of sortedSteps) {
    const result = await runStep(step, ctx, backoff);
    step_results.push(result);

    if (result.status === "BLOCKED" || result.status === "FAILED") {
      return {
        status: result.status,
        step_results,
        failed_step: step.id,
        error_code: result.error_code,
      };
    }

    // Store output for downstream steps
    ctx.artifacts.set(step.id, { artifact_ids: result.artifact_ids });
  }

  return { status: "OK", step_results };
}
