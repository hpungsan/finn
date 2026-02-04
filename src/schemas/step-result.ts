import { z } from "zod";
import { ErrorCodeSchema, StepActionSchema } from "./run-record.js";

export const StepResultSchema = z.object({
  status: z.enum(["OK", "BLOCKED", "FAILED"]),
  artifact_ids: z.array(z.string()),
  actions: z.array(StepActionSchema).optional(),
  error: ErrorCodeSchema.optional(),
  note: z.string().optional(),
});

export type StepResult = z.infer<typeof StepResultSchema>;
