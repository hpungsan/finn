import { z } from "zod";

// Exported for reuse in step-result.ts
export const ErrorCodeSchema = z.enum([
  "TIMEOUT",
  "SCHEMA_INVALID",
  "TOOL_ERROR_TRANSIENT",
  "TOOL_ERROR_PERMANENT",
  "RATE_LIMIT",
  "THRASHING",
  "HUMAN_REQUIRED",
]);

export const StatusSchema = z.enum([
  "PENDING",
  "RUNNING",
  "OK",
  "RETRYING",
  "BLOCKED",
  "FAILED",
]);

const StepEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("STARTED"), at: z.string() }),
  z.object({
    type: z.literal("RETRY"),
    at: z.string(),
    error: ErrorCodeSchema,
    repair_attempt: z.boolean().optional(),
  }),
  z.object({ type: z.literal("OK"), at: z.string() }),
  z.object({ type: z.literal("BLOCKED"), at: z.string() }),
  z.object({ type: z.literal("FAILED"), at: z.string() }),
]);

// Exported for reuse in step-result.ts
export const StepActionSchema = z
  .object({
    action_id: z.string(),
    path: z.string(),
    op: z.enum(["edit", "create", "delete", "external"]),
    pre_hash: z.string().optional(),
    post_hash: z.string().optional(),
    external_ref: z.string().optional(),
  })
  .strict();

const StepRecordSchema = z
  .object({
    step_id: z.string(),
    step_instance_id: z.string(),
    step_seq: z.number(),
    name: z.string(),
    status: StatusSchema,
    inputs_digest: z.string(),
    schema_version: z.string(),
    events: z.array(StepEventSchema),
    artifact_ids: z.array(z.string()),
    actions: z.array(StepActionSchema).optional(),
    retry_count: z.number(),
    repair_count: z.number(),
    error_code: ErrorCodeSchema.optional(),
    trace: z
      .object({
        model: z.string(),
        prompt_version: z.string(),
        inputs_digest: z.string(),
        artifact_ids_read: z.array(z.string()),
      })
      .strict()
      .optional(),
  })
  .strict();

export const RunRecordSchema = z
  .object({
    run_id: z.string(),
    owner_id: z.string(),
    status: z.enum(["RUNNING", "OK", "BLOCKED", "FAILED"]),
    workflow: z.enum(["plan", "feat", "fix"]),
    args: z.record(z.string(), z.unknown()),
    repo_hash: z.string(),
    config: z
      .object({
        rounds: z.number(),
        retries: z.number(),
        timeout_ms: z.number(),
      })
      .strict(),
    steps: z.array(StepRecordSchema),
    created_at: z.string(),
    updated_at: z.string(),
    last_error: ErrorCodeSchema.optional(),
    resume_from: z.string().optional(),
  })
  .strict();

export type RunRecord = z.infer<typeof RunRecordSchema>;
export type StepRecord = z.infer<typeof StepRecordSchema>;
export type StepEvent = z.infer<typeof StepEventSchema>;
export type StepAction = z.infer<typeof StepActionSchema>;
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;
export type Status = z.infer<typeof StatusSchema>;
