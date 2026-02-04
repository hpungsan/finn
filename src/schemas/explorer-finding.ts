import { z } from "zod";

export const ExplorerFindingSchema = z
  .object({
    files: z.array(
      z
        .object({
          path: z.string(),
          relevance: z.enum(["high", "medium", "low"]),
          summary: z.string(),
        })
        .strict(),
    ),
    patterns: z.array(z.string()),
    concerns: z.array(z.string()),
    confidence: z.number().min(0).max(1),
  })
  .strict();

export type ExplorerFinding = z.infer<typeof ExplorerFindingSchema>;
