import type { ArtifactStore } from "../artifacts/store.js";
import type { RunRecord } from "../schemas/run-record.js";
import type { StepRunnerResult } from "../schemas/step-result.js";

/** Derived from RunRecord.config to avoid type drift */
export type RunConfig = RunRecord["config"];

/** Enhanced artifact output with versions for downstream idempotency */
export interface StepOutput {
  artifact_ids: string[];
  versions: Record<string, number>; // artifact_id -> version (Record for JSON compat)
}

export const DEFAULT_RUN_CONFIG: Readonly<RunConfig> = {
  rounds: 2,
  retries: 2,
  timeout_ms: 60_000,
};

/**
 * Reference to an artifact for idempotency computation.
 * Requires version to detect upstream changes.
 */
export interface ArtifactInputRef {
  workspace: string;
  name?: string; // one of name or id required
  id?: string;
  version: number; // required — detects upstream changes
}

export interface StepInputs {
  repo_hash?: string; // for steps that read from repo
  artifact_refs?: ArtifactInputRef[];
  file_paths?: string[]; // normalized, sorted
  params?: Record<string, unknown>;
}

export interface StepContext {
  run_id: string;
  store: ArtifactStore;
  config: RunConfig;
  artifacts: Map<string, StepOutput>; // outputs from completed deps with versions
  repo_hash: string; // for steps to include in inputs
  signal?: AbortSignal; // cooperative cancellation on timeout/retry
}

export interface Step<_T = unknown> {
  id: string;
  name: string;
  deps: string[]; // step IDs for topo-sort
  timeout: number; // per-step override (ms)
  maxRetries: number; // per-step override
  model: string; // included in step_instance_id
  prompt_version: string;
  schema_version: string;

  /** Compute inputs for idempotency (pure function, no I/O) */
  getInputs(ctx: StepContext): StepInputs;

  /**
   * Execute the step.
   *
   * Cancellation contract: The executor provides `ctx.signal` (AbortSignal) for
   * cooperative cancellation. On timeout or before retry, the signal is aborted.
   * Steps SHOULD check `ctx.signal?.aborted` periodically and exit early when true.
   * Steps that ignore the signal will continue running in the background.
   *
   * Idempotency contract: Multiple run() calls may overlap if a step ignores
   * the abort signal. Steps must handle this:
   * - Use optimistic locking for artifact writes
   * - External side effects should be idempotent
   */
  run(ctx: StepContext): Promise<StepRunnerResult>;
}

/** Versioning fields extracted from Step for idempotency computation */
export type StepVersioning = Pick<
  Step,
  "model" | "prompt_version" | "schema_version"
>;
