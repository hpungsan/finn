import { z } from "zod";

/**
 * DLQ Entry schema for failed/blocked workflow runs.
 *
 * Stored as artifact with kind: "dlq-entry" in workspace: "dlq" (persistent).
 * Provides structured failure state for later investigation and resume.
 */
export const DlqEntrySchema = z.object({
  /** Workflow type that failed */
  workflow: z.enum(["plan", "feat", "fix"]),

  /** Original task/objective description */
  task: z.string().optional(),

  /** Step ID where failure occurred (for resume routing) */
  failed_step: z.string().optional(),

  /** Original workflow arguments */
  inputs: z.record(z.string(), z.unknown()).optional(),

  /** Retry count at time of failure */
  retry_count: z.number().int().nonnegative(),

  /** Error code that caused the failure */
  last_error: z.string(),

  /** Files relevant to the failure (for context) */
  relevant_files: z.array(z.string()).optional(),

  /** Artifact IDs of completed work (for partial resume) */
  partial_results: z.array(z.string()).optional(),

  /** Human-readable failure summary */
  summary: z.string().optional(),
});

export type DlqEntry = z.infer<typeof DlqEntrySchema>;
