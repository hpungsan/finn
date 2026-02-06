export type ExecutorErrorCode =
  | "CYCLE_DETECTED" // dependency graph has cycle
  | "MISSING_DEPENDENCY" // step references non-existent step
  | "DUPLICATE_STEP_ID" // multiple steps share the same id
  | "RUN_OWNED_BY_OTHER" // owner_id mismatch on resume
  | "RUN_ALREADY_COMPLETE" // RunRecord has terminal status (OK/BLOCKED/FAILED)
  | "INVALID_RUN_RECORD" // RunRecord data failed schema validation
  | "STEP_NOT_FOUND" // recordStepCompleted called without matching RUNNING record
  | "STEP_DEFINITION_MISMATCH" // RUNNING step in RunRecord not in current step definitions
  | "INVARIANT_VIOLATION"; // internal invariant violated (e.g., RUNNING steps at finalize)

export class ExecutorError extends Error {
  constructor(
    public readonly code: ExecutorErrorCode,
    message: string,
    public readonly details?: {
      step_id?: string;
      step_instance_id?: string;
      run_id?: string;
      missing_dep?: string;
      cycle?: string[];
    },
  ) {
    super(message);
    this.name = "ExecutorError";
  }
}
