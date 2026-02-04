import { describe, expect, test } from "vitest";
import {
  ErrorCodeSchema,
  RunRecordSchema,
  StatusSchema,
  StepActionSchema,
} from "../run-record.js";

describe("ErrorCodeSchema", () => {
  test("accepts valid error codes", () => {
    expect(ErrorCodeSchema.parse("TIMEOUT")).toBe("TIMEOUT");
    expect(ErrorCodeSchema.parse("SCHEMA_INVALID")).toBe("SCHEMA_INVALID");
    expect(ErrorCodeSchema.parse("HUMAN_REQUIRED")).toBe("HUMAN_REQUIRED");
  });

  test("rejects invalid error code", () => {
    expect(() => ErrorCodeSchema.parse("UNKNOWN_ERROR")).toThrow();
  });
});

describe("StatusSchema", () => {
  test("accepts valid statuses", () => {
    expect(StatusSchema.parse("PENDING")).toBe("PENDING");
    expect(StatusSchema.parse("RUNNING")).toBe("RUNNING");
    expect(StatusSchema.parse("OK")).toBe("OK");
  });

  test("rejects invalid status", () => {
    expect(() => StatusSchema.parse("DONE")).toThrow();
  });
});

describe("StepActionSchema", () => {
  test("accepts valid action", () => {
    const action = {
      action_id: "abc123",
      path: "src/file.ts",
      op: "edit",
      pre_hash: "hash1",
      post_hash: "hash2",
    };
    expect(StepActionSchema.parse(action)).toEqual(action);
  });

  test("accepts action without optional fields", () => {
    const action = {
      action_id: "abc123",
      path: "src/file.ts",
      op: "create",
    };
    expect(StepActionSchema.parse(action)).toEqual(action);
  });

  test("rejects invalid op", () => {
    expect(() =>
      StepActionSchema.parse({
        action_id: "abc",
        path: "x.ts",
        op: "rename",
      }),
    ).toThrow();
  });

  test("rejects extra fields (strict)", () => {
    expect(() =>
      StepActionSchema.parse({
        action_id: "abc",
        path: "x.ts",
        op: "edit",
        extra: "field",
      }),
    ).toThrow();
  });
});

describe("RunRecordSchema", () => {
  const validRunRecord = {
    run_id: "plan-auth-1234567890",
    owner_id: "uuid-123",
    status: "RUNNING",
    workflow: "plan",
    args: { task: "add authentication" },
    repo_hash: "abc123",
    config: {
      rounds: 2,
      retries: 3,
      timeout_ms: 60000,
    },
    steps: [
      {
        step_id: "explore-code",
        step_instance_id: "hash-123",
        step_seq: 1,
        name: "Code Explorer",
        status: "OK",
        inputs_digest: "inputs-hash",
        schema_version: "explorer-finding@1",
        events: [
          { type: "STARTED", at: "2024-01-01T00:00:00Z" },
          { type: "OK", at: "2024-01-01T00:01:00Z" },
        ],
        artifact_ids: ["artifact-1"],
        retry_count: 0,
        repair_count: 0,
      },
    ],
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:01:00Z",
  };

  test("accepts valid run record", () => {
    expect(RunRecordSchema.parse(validRunRecord)).toEqual(validRunRecord);
  });

  test("accepts run record with optional fields", () => {
    const withOptional = {
      ...validRunRecord,
      last_error: "TIMEOUT",
      resume_from: "step-2",
    };
    expect(RunRecordSchema.parse(withOptional)).toEqual(withOptional);
  });

  test("rejects invalid workflow", () => {
    expect(() =>
      RunRecordSchema.parse({
        ...validRunRecord,
        workflow: "deploy",
      }),
    ).toThrow();
  });

  test("rejects invalid run status", () => {
    expect(() =>
      RunRecordSchema.parse({
        ...validRunRecord,
        status: "PENDING", // PENDING is step status, not run status
      }),
    ).toThrow();
  });

  test("rejects missing required field", () => {
    const { run_id: _, ...missingRunId } = validRunRecord;
    expect(() => RunRecordSchema.parse(missingRunId)).toThrow();
  });

  test("accepts step with RETRY event", () => {
    const withRetry = {
      ...validRunRecord,
      steps: [
        {
          ...validRunRecord.steps[0],
          events: [
            { type: "STARTED", at: "2024-01-01T00:00:00Z" },
            {
              type: "RETRY",
              at: "2024-01-01T00:00:30Z",
              error: "TIMEOUT",
              repair_attempt: false,
            },
            { type: "OK", at: "2024-01-01T00:01:00Z" },
          ],
          retry_count: 1,
        },
      ],
    };
    expect(RunRecordSchema.parse(withRetry)).toEqual(withRetry);
  });

  test("accepts step with trace", () => {
    const withTrace = {
      ...validRunRecord,
      steps: [
        {
          ...validRunRecord.steps[0],
          trace: {
            model: "sonnet",
            prompt_version: "code-explorer@2",
            inputs_digest: "trace-inputs-hash",
            artifact_ids_read: ["artifact-0"],
          },
        },
      ],
    };
    expect(RunRecordSchema.parse(withTrace)).toEqual(withTrace);
  });
});
