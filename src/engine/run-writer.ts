import { ArtifactError, type ArtifactStore } from "../artifacts/index.js";
import { getRunRecordTtl, storeArtifact } from "../policies/ttl.js";
import {
  type RunRecord,
  RunRecordSchema,
  type StepAction,
  type StepEvent,
  type StepRecord,
} from "../schemas/run-record.js";
import type { PersistedStepResult } from "../schemas/step-result.js";
import { ExecutorError } from "./errors.js";
import type { RunConfig, Step } from "./types.js";

export interface RunWriterOpts {
  store: ArtifactStore;
  run_id: string;
  owner_id: string;
  workflow: "plan" | "feat" | "fix";
  args: Record<string, unknown>;
  repo_hash: string;
  config: RunConfig;
}

export interface InitResult {
  runRecord: RunRecord;
  isResume: boolean; // true if existing RUNNING record found
}

/**
 * Serializes RunRecord writes from concurrent step completions.
 * Uses Promise chain for serialization and optimistic locking with single retry.
 */
export class RunWriter {
  private stepSeq = 0; // Monotonic counter for step_seq
  private currentVersion = 0; // For optimistic locking
  private runRecord: RunRecord | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  private readonly store: ArtifactStore;
  private readonly run_id: string;
  private readonly owner_id: string;
  private readonly workflow: "plan" | "feat" | "fix";
  private readonly args: Record<string, unknown>;
  private readonly repo_hash: string;
  private readonly config: RunConfig;

  constructor(opts: RunWriterOpts) {
    this.store = opts.store;
    this.run_id = opts.run_id;
    this.owner_id = opts.owner_id;
    this.workflow = opts.workflow;
    this.args = opts.args;
    this.repo_hash = opts.repo_hash;
    this.config = opts.config;
  }

  /**
   * Initialize new run or load existing for resume.
   * - If no existing record: create new with status RUNNING
   * - If existing with status RUNNING: resume mode (isResume=true)
   * - If existing with terminal status: throw RUN_ALREADY_COMPLETE
   * - If existing with different owner_id: throw RUN_OWNED_BY_OTHER
   */
  async init(): Promise<InitResult> {
    const existing = await this.store.fetch({
      workspace: "runs",
      name: this.run_id,
    });

    if (!existing) {
      // New run
      const now = new Date().toISOString();
      const runRecord: RunRecord = {
        run_id: this.run_id,
        owner_id: this.owner_id,
        status: "RUNNING",
        workflow: this.workflow,
        args: this.args,
        repo_hash: this.repo_hash,
        config: this.config,
        steps: [],
        created_at: now,
        updated_at: now,
      };

      const artifact = await storeArtifact(this.store, {
        workspace: "runs",
        name: this.run_id,
        kind: "run-record",
        data: runRecord,
        ttl_seconds: getRunRecordTtl("FAILED"), // Conservative TTL until finalized
      });

      this.runRecord = runRecord;
      this.currentVersion = artifact.version;
      return { runRecord, isResume: false };
    }

    // Validate schema
    const parsed = RunRecordSchema.safeParse(existing.data);
    if (!parsed.success) {
      throw new ExecutorError(
        "INVALID_RUN_RECORD",
        `Corrupted RunRecord: ${parsed.error.message}`,
      );
    }
    const runRecord = parsed.data;

    // Owner check
    if (runRecord.owner_id !== this.owner_id) {
      throw new ExecutorError(
        "RUN_OWNED_BY_OTHER",
        `Run ${this.run_id} owned by ${runRecord.owner_id}`,
      );
    }

    // Status check
    if (runRecord.status !== "RUNNING") {
      throw new ExecutorError(
        "RUN_ALREADY_COMPLETE",
        `Run ${this.run_id} already ${runRecord.status}`,
      );
    }

    // Resume mode - restore step_seq from existing steps
    this.stepSeq =
      runRecord.steps.length > 0
        ? Math.max(...runRecord.steps.map((s) => s.step_seq))
        : 0;
    this.currentVersion = existing.version;
    this.runRecord = runRecord;

    return { runRecord, isResume: true };
  }

  /**
   * Record step STARTED (before execution).
   *
   * Idempotent: If step_instance_id already exists, no-op (resume scenario).
   * This prevents duplicate StepRecords when re-running a step that was
   * RUNNING at crash time.
   */
  async recordStepStarted(
    step: Step,
    step_instance_id: string,
    inputs_digest: string,
  ): Promise<void> {
    const now_ts = new Date().toISOString();

    await this.enqueueWrite((record) => {
      // Check if step_instance_id already exists (resume scenario)
      const existing = record.steps.find(
        (s) => s.step_instance_id === step_instance_id,
      );
      if (existing) {
        // Already recorded - no-op to prevent duplicates
        // The existing record will be updated by recordStepCompleted()
        return;
      }

      // Normal path: append new record
      const stepSeq = this.nextStepSeq();
      const stepRecord: StepRecord = {
        step_id: step.id,
        step_instance_id,
        step_seq: stepSeq,
        name: step.name,
        status: "RUNNING",
        inputs_digest,
        schema_version: step.schema_version,
        events: [{ type: "STARTED", at: now_ts }],
        artifact_ids: [],
        retry_count: 0,
        repair_count: 0,
      };
      record.steps.push(stepRecord);
      record.updated_at = now_ts;
    });
  }

  /**
   * Record step completion (OK/BLOCKED/FAILED).
   *
   * Prefers RUNNING record if multiple exist (defensive against duplicates).
   * Throws if no matching record found.
   */
  async recordStepCompleted(
    _step: Step,
    step_instance_id: string,
    status: "OK" | "BLOCKED" | "FAILED",
    events: StepEvent[],
    artifact_ids: string[],
    actions: StepAction[] | undefined,
    retry_count: number,
    repair_count: number,
    error_code?: string,
  ): Promise<void> {
    const now_ts = new Date().toISOString();

    await this.enqueueWrite((record) => {
      const matches = record.steps.filter(
        (s) => s.step_instance_id === step_instance_id,
      );

      if (matches.length === 0) {
        throw new ExecutorError(
          "STEP_NOT_FOUND",
          `No StepRecord found for step_instance_id ${step_instance_id}`,
        );
      }

      if (matches.length > 1) {
        console.warn(
          `Multiple StepRecords for ${step_instance_id}, updating RUNNING one`,
        );
      }

      // Prefer RUNNING record (normal case), fall back to first match
      const stepRecord =
        matches.find((s) => s.status === "RUNNING") ?? matches[0];

      stepRecord.status = status;
      stepRecord.events = events;
      stepRecord.artifact_ids = artifact_ids;
      if (actions && actions.length > 0) {
        stepRecord.actions = actions;
      }
      stepRecord.retry_count = retry_count;
      stepRecord.repair_count = repair_count;
      if (error_code) {
        // Type assertion needed since error_code comes from ErrorCode type
        stepRecord.error_code = error_code as StepRecord["error_code"];
      }
      record.updated_at = now_ts;
    });
  }

  /**
   * Record step SKIPPED (idempotency hit).
   *
   * Idempotent: If step_instance_id already exists with terminal status, no-op.
   * This prevents duplicate StepRecords when resuming a run that had
   * completed steps before crash.
   */
  async recordStepSkipped(
    step: Step,
    step_instance_id: string,
    inputs_digest: string,
    data: PersistedStepResult,
  ): Promise<void> {
    const now_ts = new Date().toISOString();

    await this.enqueueWrite((record) => {
      // Check if step_instance_id already exists with terminal status
      const existing = record.steps.find(
        (s) => s.step_instance_id === step_instance_id,
      );
      if (
        existing &&
        (existing.status === "OK" ||
          existing.status === "BLOCKED" ||
          existing.status === "FAILED")
      ) {
        // Already have terminal record - no-op to prevent duplicates
        return;
      }

      // Normal path: append SKIPPED record
      const stepSeq = this.nextStepSeq();
      const stepRecord: StepRecord = {
        step_id: step.id,
        step_instance_id,
        step_seq: stepSeq,
        name: step.name,
        status: data.status,
        inputs_digest,
        schema_version: step.schema_version,
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
      record.steps.push(stepRecord);
      record.updated_at = now_ts;
    });
  }

  /**
   * Record step RECOVERED (crash recovery from step-result artifact).
   */
  async recordStepRecovered(
    _step: Step,
    step_instance_id: string,
    data: PersistedStepResult,
  ): Promise<void> {
    const now_ts = new Date().toISOString();

    await this.enqueueWrite((record) => {
      const stepRecord = record.steps.find(
        (s) => s.step_instance_id === step_instance_id,
      );
      if (!stepRecord) {
        // Invariant violation: step_instance_id came from this record's steps
        throw new ExecutorError(
          "STEP_NOT_FOUND",
          `recordStepRecovered: step_instance_id ${step_instance_id} not found in RunRecord`,
          { step_instance_id, run_id: this.run_id },
        );
      }

      stepRecord.status = data.status;
      stepRecord.events = [
        ...stepRecord.events,
        { type: "RECOVERED", at: now_ts },
        { type: data.status, at: now_ts },
      ];
      stepRecord.artifact_ids = data.artifact_ids;
      if ("actions" in data && data.actions) {
        stepRecord.actions = data.actions;
      }
      if ("error" in data && data.error) {
        stepRecord.error_code = data.error;
      }
      record.updated_at = now_ts;
    });
  }

  /**
   * Finalize run status and align step-result TTLs.
   *
   * Step-results are stored with conservative 30-day TTL during execution.
   * At finalize, we align all step-result TTLs to match the run's final TTL:
   * - OK run → 7 days (downgrade from 30)
   * - BLOCKED/FAILED run → 30 days (no change needed)
   */
  async finalize(
    status: "OK" | "BLOCKED" | "FAILED",
    last_error?: string,
  ): Promise<RunRecord> {
    const now_ts = new Date().toISOString();

    await this.enqueueWrite((record) => {
      record.status = status;
      record.updated_at = now_ts;
      if (last_error) {
        record.last_error = last_error as RunRecord["last_error"];
      }
    });

    // Update TTL based on final status
    const finalTtl = getRunRecordTtl(status);
    const artifact = await this.store.store({
      workspace: "runs",
      name: this.run_id,
      kind: "run-record",
      // biome-ignore lint/style/noNonNullAssertion: runRecord is set after init()
      data: this.runRecord!,
      ttl_seconds: finalTtl,
      expected_version: this.currentVersion,
      mode: "replace",
    });
    this.currentVersion = artifact.version;

    // Align step-result TTLs to match run TTL
    // Only needed for OK runs (downgrade from 30d to 7d)
    // BLOCKED/FAILED already have 30d TTL
    if (status === "OK") {
      await this.alignStepResultTtls(finalTtl);
    }

    // biome-ignore lint/style/noNonNullAssertion: runRecord is set after init()
    return this.runRecord!;
  }

  /**
   * Align all step-result artifact TTLs to match the run's final TTL.
   * Reconstructs PersistedStepResult from StepRecord to avoid extra fetches.
   */
  private async alignStepResultTtls(ttlSeconds: number): Promise<void> {
    if (!this.runRecord) return;

    // Only align terminal steps (skip RUNNING - shouldn't exist at finalize)
    const terminalSteps = this.runRecord.steps.filter(
      (s) =>
        s.status === "OK" || s.status === "BLOCKED" || s.status === "FAILED",
    );

    const updates = terminalSteps.map(async (stepRecord) => {
      // Reconstruct PersistedStepResult from StepRecord
      const data =
        stepRecord.status === "OK"
          ? {
              status: "OK" as const,
              artifact_ids: stepRecord.artifact_ids,
              actions: stepRecord.actions,
            }
          : {
              status: stepRecord.status as "BLOCKED" | "FAILED",
              artifact_ids: stepRecord.artifact_ids,
              actions: stepRecord.actions,
              // biome-ignore lint/style/noNonNullAssertion: error_code guaranteed for BLOCKED/FAILED steps
              error: stepRecord.error_code!,
            };

      // Run-scoped naming ensures TTL alignment targets this run's step-results only
      await storeArtifact(this.store, {
        workspace: "runs",
        name: `${this.run_id}-${stepRecord.step_instance_id}`,
        kind: "step-result",
        data,
        run_id: this.run_id,
        ttl_seconds: ttlSeconds,
        mode: "replace",
      });
    });

    await Promise.all(updates);
  }

  /**
   * Get current in-memory record.
   */
  getRunRecord(): RunRecord | null {
    return this.runRecord;
  }

  /**
   * Get next step_seq (atomic increment).
   */
  nextStepSeq(): number {
    return ++this.stepSeq;
  }

  /**
   * Enqueue a write operation to be serialized.
   * Uses optimistic locking with single retry on VERSION_MISMATCH.
   */
  private async enqueueWrite(
    mutate: (record: RunRecord) => void,
  ): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      await this.persistWithRetry(mutate);
    });

    await this.writeQueue;
  }

  /**
   * Persist RunRecord with single retry on VERSION_MISMATCH.
   */
  private async persistWithRetry(
    mutate: (record: RunRecord) => void,
  ): Promise<void> {
    if (!this.runRecord) {
      throw new Error("RunWriter not initialized");
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        // Clone so a failed optimistic write doesn't mutate in-memory state.
        const next = structuredClone(this.runRecord);
        mutate(next);

        const artifact = await this.store.store({
          workspace: "runs",
          name: this.run_id,
          kind: "run-record",
          data: next,
          ttl_seconds: getRunRecordTtl("FAILED"), // Conservative until finalized
          expected_version: this.currentVersion,
          mode: "replace",
        });
        this.runRecord = next;
        this.currentVersion = artifact.version;
        return;
      } catch (e) {
        if (e instanceof ArtifactError && e.code === "VERSION_MISMATCH") {
          if (attempt === 0) {
            // Reload and retry once
            const existing = await this.store.fetch({
              workspace: "runs",
              name: this.run_id,
            });
            if (existing) {
              const parsed = RunRecordSchema.safeParse(existing.data);
              if (parsed.success) {
                // Re-check invariants after reload
                if (parsed.data.owner_id !== this.owner_id) {
                  throw new ExecutorError(
                    "RUN_OWNED_BY_OTHER",
                    `Run ${this.run_id} was taken by ${parsed.data.owner_id} during write`,
                  );
                }
                if (parsed.data.status !== "RUNNING") {
                  throw new ExecutorError(
                    "RUN_ALREADY_COMPLETE",
                    `Run ${this.run_id} was finalized (${parsed.data.status}) during write`,
                  );
                }
                // Safe to reload and retry
                this.runRecord = parsed.data;
                this.currentVersion = existing.version;
                continue;
              }
            }
          }
          throw new ExecutorError(
            "INVALID_RUN_RECORD",
            "VERSION_MISMATCH after retry",
          );
        }
        throw e;
      }
    }
  }
}
