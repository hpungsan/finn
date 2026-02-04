import { z } from "zod";
import { ErrorCodeSchema, StepActionSchema } from "./run-record.js";

/**
 * What step runners return (includes RETRY for engine loop).
 * Used by engine to determine next action.
 */
export const StepRunnerResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("OK"),
      artifact_ids: z.array(z.string()),
      actions: z.array(StepActionSchema).optional(),
    })
    .strict(),
  z
    .object({
      status: z.literal("RETRY"),
      error: ErrorCodeSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("BLOCKED"),
      artifact_ids: z.array(z.string()),
      actions: z.array(StepActionSchema).optional(),
      error: ErrorCodeSchema,
      note: z.string().optional(),
    })
    .strict(),
  z
    .object({
      status: z.literal("FAILED"),
      artifact_ids: z.array(z.string()),
      actions: z.array(StepActionSchema).optional(),
      error: ErrorCodeSchema,
      note: z.string().optional(),
    })
    .strict(),
]);

export type StepRunnerResult = z.infer<typeof StepRunnerResultSchema>;

/**
 * What gets persisted as kind:"step-result" artifact (terminal states only).
 * RETRY is not persisted — engine loops until terminal.
 */
export const PersistedStepResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("OK"),
      artifact_ids: z.array(z.string()),
      actions: z.array(StepActionSchema).optional(),
    })
    .strict(),
  z
    .object({
      status: z.literal("BLOCKED"),
      artifact_ids: z.array(z.string()),
      actions: z.array(StepActionSchema).optional(),
      error: ErrorCodeSchema,
      note: z.string().optional(),
    })
    .strict(),
  z
    .object({
      status: z.literal("FAILED"),
      artifact_ids: z.array(z.string()),
      actions: z.array(StepActionSchema).optional(),
      error: ErrorCodeSchema,
      note: z.string().optional(),
    })
    .strict(),
]);

export type PersistedStepResult = z.infer<typeof PersistedStepResultSchema>;
