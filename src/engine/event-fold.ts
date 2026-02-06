import type { Status, StepEvent, StepRecord } from "../schemas/run-record.js";

export interface FoldedState {
  status: Status;
  retry_count: number;
  repair_count: number;
}

/**
 * Derive status, retry_count, and repair_count by folding events.
 *
 * Fold rules:
 *   STARTED   → RUNNING
 *   RETRY     → retry_count++, if repair_attempt then repair_count++
 *               (status stays RUNNING — RETRY events are only persisted
 *               alongside terminal events, so RETRYING is never the final
 *               folded status)
 *   OK        → OK
 *   BLOCKED   → BLOCKED
 *   FAILED    → FAILED
 *   SKIPPED   → no status change (followed by terminal event)
 *   RECOVERED → RUNNING (re-entering execution)
 *
 * Empty events → PENDING, 0, 0
 */
export function foldEvents(events: StepEvent[]): FoldedState {
  let status: Status = "PENDING";
  let retry_count = 0;
  let repair_count = 0;

  for (const event of events) {
    switch (event.type) {
      case "STARTED":
        status = "RUNNING";
        break;
      case "RETRY":
        retry_count++;
        if (event.repair_attempt) {
          repair_count++;
        }
        // Status stays RUNNING — see note above
        break;
      case "OK":
        status = "OK";
        break;
      case "BLOCKED":
        status = "BLOCKED";
        break;
      case "FAILED":
        status = "FAILED";
        break;
      case "SKIPPED":
        // No status change — followed by terminal event
        break;
      case "RECOVERED":
        status = "RUNNING";
        break;
    }
  }

  return { status, retry_count, repair_count };
}

/**
 * Overwrite status/retry_count/repair_count on a StepRecord from its events.
 *
 * Logs drift via console.debug for each field that mismatches (helps catch
 * write-path bugs). Does not modify error_code (BLOCKED/FAILED events don't
 * carry an error field; would need schema migration to fix).
 *
 * Returns the same object (mutated).
 */
export function applyEventFold(step: StepRecord): StepRecord {
  const folded = foldEvents(step.events);

  if (step.status !== folded.status) {
    console.debug(
      `[event-fold] drift: step ${step.step_instance_id} status stored=${step.status} derived=${folded.status}`,
    );
  }
  if (step.retry_count !== folded.retry_count) {
    console.debug(
      `[event-fold] drift: step ${step.step_instance_id} retry_count stored=${step.retry_count} derived=${folded.retry_count}`,
    );
  }
  if (step.repair_count !== folded.repair_count) {
    console.debug(
      `[event-fold] drift: step ${step.step_instance_id} repair_count stored=${step.repair_count} derived=${folded.repair_count}`,
    );
  }

  step.status = folded.status;
  step.retry_count = folded.retry_count;
  step.repair_count = folded.repair_count;

  return step;
}
