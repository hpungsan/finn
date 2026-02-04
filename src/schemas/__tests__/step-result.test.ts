import { describe, expect, test } from "vitest";
import {
  PersistedStepResultSchema,
  StepRunnerResultSchema,
} from "../step-result.js";

describe("StepRunnerResultSchema", () => {
  test("accepts OK result", () => {
    const ok = {
      status: "OK",
      artifact_ids: ["artifact-1", "artifact-2"],
    };
    expect(StepRunnerResultSchema.parse(ok)).toEqual(ok);
  });

  test("accepts OK result with actions", () => {
    const ok = {
      status: "OK",
      artifact_ids: ["artifact-1"],
      actions: [
        {
          action_id: "action-1",
          path: "src/file.ts",
          op: "edit",
          pre_hash: "before",
          post_hash: "after",
        },
      ],
    };
    expect(StepRunnerResultSchema.parse(ok)).toEqual(ok);
  });

  test("accepts RETRY result", () => {
    const retry = {
      status: "RETRY",
      error: "TIMEOUT",
    };
    expect(StepRunnerResultSchema.parse(retry)).toEqual(retry);
  });

  test("accepts BLOCKED result", () => {
    const blocked = {
      status: "BLOCKED",
      artifact_ids: [],
      error: "HUMAN_REQUIRED",
      note: "Need clarification on requirements",
    };
    expect(StepRunnerResultSchema.parse(blocked)).toEqual(blocked);
  });

  test("accepts FAILED result", () => {
    const failed = {
      status: "FAILED",
      artifact_ids: ["partial-artifact"],
      error: "TOOL_ERROR_PERMANENT",
    };
    expect(StepRunnerResultSchema.parse(failed)).toEqual(failed);
  });

  test("rejects OK with error field", () => {
    expect(() =>
      StepRunnerResultSchema.parse({
        status: "OK",
        artifact_ids: [],
        error: "TIMEOUT", // not allowed for OK
      }),
    ).toThrow();
  });

  test("rejects RETRY without error", () => {
    expect(() =>
      StepRunnerResultSchema.parse({
        status: "RETRY",
        // missing error
      }),
    ).toThrow();
  });

  test("rejects RETRY with artifact_ids", () => {
    expect(() =>
      StepRunnerResultSchema.parse({
        status: "RETRY",
        error: "TIMEOUT",
        artifact_ids: [], // not allowed for RETRY
      }),
    ).toThrow();
  });

  test("rejects invalid status", () => {
    expect(() =>
      StepRunnerResultSchema.parse({
        status: "PENDING",
        artifact_ids: [],
      }),
    ).toThrow();
  });
});

describe("PersistedStepResultSchema", () => {
  test("accepts OK result", () => {
    const ok = {
      status: "OK",
      artifact_ids: ["artifact-1"],
    };
    expect(PersistedStepResultSchema.parse(ok)).toEqual(ok);
  });

  test("accepts BLOCKED result", () => {
    const blocked = {
      status: "BLOCKED",
      artifact_ids: [],
      error: "HUMAN_REQUIRED",
      note: "Blocked on external dependency",
    };
    expect(PersistedStepResultSchema.parse(blocked)).toEqual(blocked);
  });

  test("accepts FAILED result", () => {
    const failed = {
      status: "FAILED",
      artifact_ids: [],
      error: "THRASHING",
      note: "Same issues across 2 rounds",
    };
    expect(PersistedStepResultSchema.parse(failed)).toEqual(failed);
  });

  test("rejects RETRY status (not persisted)", () => {
    expect(() =>
      PersistedStepResultSchema.parse({
        status: "RETRY",
        error: "TIMEOUT",
      }),
    ).toThrow();
  });

  test("rejects BLOCKED without error", () => {
    expect(() =>
      PersistedStepResultSchema.parse({
        status: "BLOCKED",
        artifact_ids: [],
        // missing error
      }),
    ).toThrow();
  });
});
