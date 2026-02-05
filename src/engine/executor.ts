import type { ArtifactStore } from "../artifacts/store.js";
import { getRunRecordTtl, storeArtifact } from "../policies/ttl.js";
import type {
  ErrorCode,
  StepAction,
  StepEvent,
} from "../schemas/run-record.js";
import {
  type PersistedStepResult,
  PersistedStepResultSchema,
  type StepRunnerResult,
} from "../schemas/step-result.js";
import { groupIntoBatches } from "./batch.js";
import { ExecutorError } from "./errors.js";
import { computeStepIdempotency } from "./idempotency.js";
import { RunWriter } from "./run-writer.js";
import { Semaphore } from "./semaphore.js";
import type { Step, StepContext } from "./types.js";

export interface ExecuteOpts {
  steps: Step[];
  ctx: StepContext;
  backoff?: BackoffConfig;
  concurrency?: number; // default 4
  runWriter?: RunWriter; // injectable for testing
  // Run metadata (required for RunWriter creation)
  owner_id: string;
  workflow: "plan" | "feat" | "fix";
  args: Record<string, unknown>;
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
  repair_count: number;
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
 * Collect versions for artifact IDs by fetching from store.
 * Fetches in parallel for efficiency.
 */
export async function collectVersions(
  store: ArtifactStore,
  artifact_ids: string[],
): Promise<Record<string, number>> {
  if (artifact_ids.length === 0) return {};

  const results = await Promise.all(
    artifact_ids.map(async (id) => {
      const artifact = await store.fetch({ id });
      return { id, version: artifact?.version };
    }),
  );

  const versions: Record<string, number> = {};
  for (const { id, version } of results) {
    if (version !== undefined) {
      versions[id] = version;
    }
  }
  return versions;
}

/**
 * Persist step result as artifact for idempotency.
 */
async function persistStepResult(
  store: ArtifactStore,
  run_id: string,
  step_instance_id: string,
  result: StepExecutionResult,
): Promise<void> {
  const data: PersistedStepResult =
    result.status === "OK"
      ? {
          status: "OK",
          artifact_ids: result.artifact_ids,
          actions: result.actions,
        }
      : {
          status: result.status,
          artifact_ids: result.artifact_ids,
          actions: result.actions,
          // biome-ignore lint/style/noNonNullAssertion: error_code required for non-OK status
          error: result.error_code!,
        };

  await storeArtifact(store, {
    workspace: "runs",
    name: step_instance_id,
    kind: "step-result",
    data,
    run_id,
    ttl_seconds: getRunRecordTtl(result.status),
    mode: "replace", // Idempotent
  });
}

/**
 * Check if step can be skipped due to existing step-result.
 */
async function checkIdempotencySkip(
  step: Step,
  ctx: StepContext,
  writer: RunWriter,
): Promise<StepExecutionResult | null> {
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

  // Check for existing step-result artifact
  const existing = await ctx.store.fetch({
    workspace: "runs",
    name: step_instance_id,
  });

  if (!existing) return null;

  // Validate schema to handle corrupted data gracefully
  const parsed = PersistedStepResultSchema.safeParse(existing.data);
  if (!parsed.success) {
    console.warn(
      `Corrupted step-result ${step_instance_id}, re-running: ${parsed.error.message}`,
    );
    return null; // Will re-run step
  }
  const data = parsed.data;

  const now_ts = new Date().toISOString();

  // Record SKIPPED in RunRecord
  await writer.recordStepSkipped(step, step_instance_id, inputs_digest, data);

  // Return reconstructed result with SKIPPED event
  return {
    step_id: step.id,
    step_instance_id,
    inputs_digest,
    status: data.status,
    events: [
      { type: "STARTED", at: now_ts },
      { type: "SKIPPED", at: now_ts, reason: "idempotent" },
      { type: data.status, at: now_ts },
    ],
    artifact_ids: data.artifact_ids ?? [],
    actions: "actions" in data ? data.actions : undefined,
    retry_count: 0,
    repair_count: 0,
    error_code: "error" in data ? data.error : undefined,
  };
}

/**
 * Recover from crash by restoring state from RunRecord and step-result artifacts.
 */
async function recoverFromCrash(
  writer: RunWriter,
  ctx: StepContext,
  steps: Step[],
): Promise<void> {
  const runRecord = writer.getRunRecord();
  if (!runRecord) return;

  const stepMap = new Map(steps.map((s) => [s.id, s]));

  // Restore completed steps' artifacts to ctx.artifacts
  for (const stepRecord of runRecord.steps) {
    if (
      stepRecord.status === "OK" ||
      stepRecord.status === "BLOCKED" ||
      stepRecord.status === "FAILED"
    ) {
      const versions = await collectVersions(
        ctx.store,
        stepRecord.artifact_ids,
      );
      ctx.artifacts.set(stepRecord.step_id, {
        artifact_ids: stepRecord.artifact_ids,
        versions,
      });
    }
  }

  // Handle steps that were RUNNING when crash occurred
  const runningSteps = runRecord.steps.filter((s) => s.status === "RUNNING");

  for (const stepRecord of runningSteps) {
    const step = stepMap.get(stepRecord.step_id);
    if (!step) {
      console.warn(
        `Step ${stepRecord.step_id} in RunRecord but not in step definitions`,
      );
      continue;
    }

    // Check if step-result artifact exists (crash between step completion and RunRecord update)
    const stepResultArtifact = await ctx.store.fetch({
      workspace: "runs",
      name: stepRecord.step_instance_id,
    });

    if (stepResultArtifact) {
      // Validate schema
      const parsed = PersistedStepResultSchema.safeParse(
        stepResultArtifact.data,
      );
      if (!parsed.success) {
        console.warn(
          `Corrupted step-result ${stepRecord.step_instance_id}, will re-run`,
        );
        continue; // Will re-run via normal idempotency check
      }
      const data = parsed.data;

      // Finalize from step-result (add RECOVERED event)
      await writer.recordStepRecovered(step, stepRecord.step_instance_id, data);

      // Populate ctx.artifacts with versions
      const versions = await collectVersions(
        ctx.store,
        data.artifact_ids ?? [],
      );
      ctx.artifacts.set(step.id, {
        artifact_ids: data.artifact_ids ?? [],
        versions,
      });

      console.info(`Recovered step ${step.id} from step-result artifact`);
    } else {
      // No step-result found - step will re-run
      console.warn(
        `Step ${stepRecord.step_id} was RUNNING but no step-result found, will re-run`,
      );
    }
  }
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
 * Run step with semaphore for concurrency control.
 */
async function runStepWithSemaphore(
  step: Step,
  ctx: StepContext,
  sem: Semaphore,
  writer: RunWriter,
  backoff: BackoffConfig,
): Promise<StepExecutionResult> {
  await sem.acquire();
  try {
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

    // Record step started
    await writer.recordStepStarted(step, step_instance_id, inputs_digest);

    // Run the step
    const result = await runStep(step, ctx, backoff);

    // Persist step result for idempotency
    await persistStepResult(ctx.store, ctx.run_id, step_instance_id, result);

    // Record step completed
    await writer.recordStepCompleted(
      step,
      step_instance_id,
      result.status,
      result.events,
      result.artifact_ids,
      result.actions,
      result.retry_count,
      result.repair_count,
      result.error_code,
    );

    return result;
  } finally {
    sem.release();
  }
}

/**
 * Check idempotency for batch of steps, separating toRun from skipped.
 */
async function checkBatchIdempotency(
  batch: Step[],
  ctx: StepContext,
  writer: RunWriter,
): Promise<{ toRun: Step[]; skipped: StepExecutionResult[] }> {
  const toRun: Step[] = [];
  const skipped: StepExecutionResult[] = [];

  for (const step of batch) {
    const skipResult = await checkIdempotencySkip(step, ctx, writer);
    if (skipResult) {
      skipped.push(skipResult);
      // Populate ctx.artifacts for skipped steps too
      const versions = await collectVersions(
        ctx.store,
        skipResult.artifact_ids,
      );
      ctx.artifacts.set(step.id, {
        artifact_ids: skipResult.artifact_ids,
        versions,
      });
    } else {
      toRun.push(step);
    }
  }

  return { toRun, skipped };
}

/**
 * Execute steps in topological order with parallel batching.
 *
 * Stops on first BLOCKED or FAILED step (at batch boundary).
 * Uses semaphore for concurrency control.
 * Supports idempotency skipping and crash recovery.
 */
export async function execute(opts: ExecuteOpts): Promise<ExecuteResult> {
  const {
    steps,
    ctx,
    backoff = DEFAULT_BACKOFF,
    concurrency = 4,
    owner_id,
    workflow,
    args,
  } = opts;

  // 1. Validate and sort
  const sortedSteps = topoSort(steps);
  const batches = groupIntoBatches(sortedSteps);

  // 2. Initialize RunWriter (auto-detects resume)
  const writer =
    opts.runWriter ??
    new RunWriter({
      store: ctx.store,
      run_id: ctx.run_id,
      owner_id,
      workflow,
      args,
      repo_hash: ctx.repo_hash,
      config: ctx.config,
    });

  // 3. Init and handle crash recovery (automatic detection)
  const { isResume } = await writer.init();
  if (isResume) {
    await recoverFromCrash(writer, ctx, sortedSteps);
  }

  // 4. Create semaphore
  const sem = new Semaphore(concurrency);

  // 5. Execute batches sequentially, steps within batch in parallel
  const step_results: StepExecutionResult[] = [];
  let failedStep: string | undefined;
  let finalError: ErrorCode | undefined;

  for (const batch of batches) {
    // Check idempotency skip for each step
    const { toRun, skipped } = await checkBatchIdempotency(batch, ctx, writer);
    step_results.push(...skipped);

    // Check if any skipped step was BLOCKED/FAILED
    for (const skipResult of skipped) {
      if (skipResult.status === "BLOCKED" || skipResult.status === "FAILED") {
        if (!failedStep) {
          failedStep = skipResult.step_id;
          finalError = skipResult.error_code;
        }
      }
    }

    // If we found a failure in skipped results, stop
    if (failedStep) break;

    // Run remaining steps with Promise.allSettled
    const batchPromises = toRun.map((step) =>
      runStepWithSemaphore(step, ctx, sem, writer, backoff),
    );
    const settled = await Promise.allSettled(batchPromises);

    // Process results, update ctx.artifacts with versions
    for (let i = 0; i < settled.length; i++) {
      const result = settled[i];
      const step = toRun[i];

      if (result.status === "fulfilled") {
        const stepResult = result.value;
        step_results.push(stepResult);

        // Collect versions and populate ctx.artifacts
        if (stepResult.status === "OK") {
          const versions = await collectVersions(
            ctx.store,
            stepResult.artifact_ids,
          );
          ctx.artifacts.set(step.id, {
            artifact_ids: stepResult.artifact_ids,
            versions,
          });
        }

        if (stepResult.status === "BLOCKED" || stepResult.status === "FAILED") {
          if (!failedStep) {
            failedStep = stepResult.step_id;
            finalError = stepResult.error_code;
          }
        }
      } else {
        // Promise rejected (shouldn't happen with our error handling, but handle gracefully)
        const errorResult: StepExecutionResult = {
          step_id: step.id,
          step_instance_id: "",
          inputs_digest: "",
          status: "FAILED",
          events: [
            { type: "STARTED", at: new Date().toISOString() },
            { type: "FAILED", at: new Date().toISOString() },
          ],
          artifact_ids: [],
          retry_count: 0,
          repair_count: 0,
          error_code: "TOOL_ERROR_TRANSIENT",
        };
        step_results.push(errorResult);
        if (!failedStep) {
          failedStep = step.id;
          finalError = "TOOL_ERROR_TRANSIENT";
        }
      }
    }

    // Stop if any step BLOCKED/FAILED
    if (failedStep) break;
  }

  // 6. Finalize
  const finalStatus: "OK" | "BLOCKED" | "FAILED" = failedStep
    ? (step_results.find((r) => r.step_id === failedStep)?.status ?? "FAILED")
    : "OK";
  await writer.finalize(finalStatus, finalError);

  return {
    status: finalStatus,
    step_results,
    failed_step: failedStep,
    error_code: finalError,
  };
}
