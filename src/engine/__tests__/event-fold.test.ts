import { describe, expect, test, vi } from "vitest";
import type { StepEvent, StepRecord } from "../../schemas/run-record.js";
import { applyEventFold, foldEvents } from "../event-fold.js";

function makeStep(
  overrides: Partial<StepRecord> & { events: StepEvent[] },
): StepRecord {
  return {
    step_id: "step-1",
    step_instance_id: "instance-1",
    step_seq: 1,
    name: "step-1",
    status: "PENDING",
    inputs_digest: "digest-1",
    schema_version: "1.0",
    events: [],
    artifact_ids: [],
    retry_count: 0,
    repair_count: 0,
    ...overrides,
  };
}

const ts = "2024-01-01T00:00:00Z";

describe("foldEvents", () => {
  test("empty events → PENDING, 0, 0", () => {
    expect(foldEvents([])).toEqual({
      status: "PENDING",
      retry_count: 0,
      repair_count: 0,
    });
  });

  test("[STARTED] → RUNNING, 0, 0", () => {
    expect(foldEvents([{ type: "STARTED", at: ts }])).toEqual({
      status: "RUNNING",
      retry_count: 0,
      repair_count: 0,
    });
  });

  test("[STARTED, OK] → OK, 0, 0", () => {
    expect(
      foldEvents([
        { type: "STARTED", at: ts },
        { type: "OK", at: ts },
      ]),
    ).toEqual({
      status: "OK",
      retry_count: 0,
      repair_count: 0,
    });
  });

  test("[STARTED, BLOCKED] → BLOCKED, 0, 0", () => {
    expect(
      foldEvents([
        { type: "STARTED", at: ts },
        { type: "BLOCKED", at: ts },
      ]),
    ).toEqual({
      status: "BLOCKED",
      retry_count: 0,
      repair_count: 0,
    });
  });

  test("[STARTED, FAILED] → FAILED, 0, 0", () => {
    expect(
      foldEvents([
        { type: "STARTED", at: ts },
        { type: "FAILED", at: ts },
      ]),
    ).toEqual({
      status: "FAILED",
      retry_count: 0,
      repair_count: 0,
    });
  });

  test("[STARTED, RETRY, OK] → OK, 1, 0", () => {
    expect(
      foldEvents([
        { type: "STARTED", at: ts },
        { type: "RETRY", at: ts, error: "TIMEOUT" },
        { type: "OK", at: ts },
      ]),
    ).toEqual({
      status: "OK",
      retry_count: 1,
      repair_count: 0,
    });
  });

  test("[STARTED, RETRY, RETRY, OK] → OK, 2, 0", () => {
    expect(
      foldEvents([
        { type: "STARTED", at: ts },
        { type: "RETRY", at: ts, error: "TIMEOUT" },
        { type: "RETRY", at: ts, error: "RATE_LIMIT" },
        { type: "OK", at: ts },
      ]),
    ).toEqual({
      status: "OK",
      retry_count: 2,
      repair_count: 0,
    });
  });

  test("[STARTED, RETRY, RETRY, FAILED] → FAILED, 2, 0", () => {
    expect(
      foldEvents([
        { type: "STARTED", at: ts },
        { type: "RETRY", at: ts, error: "TIMEOUT" },
        { type: "RETRY", at: ts, error: "TIMEOUT" },
        { type: "FAILED", at: ts },
      ]),
    ).toEqual({
      status: "FAILED",
      retry_count: 2,
      repair_count: 0,
    });
  });

  test("[STARTED, RETRY(repair), OK] → OK, 1, 1", () => {
    expect(
      foldEvents([
        { type: "STARTED", at: ts },
        {
          type: "RETRY",
          at: ts,
          error: "SCHEMA_INVALID",
          repair_attempt: true,
        },
        { type: "OK", at: ts },
      ]),
    ).toEqual({
      status: "OK",
      retry_count: 1,
      repair_count: 1,
    });
  });

  test("[STARTED, RETRY, RETRY(repair), BLOCKED] → BLOCKED, 2, 1", () => {
    expect(
      foldEvents([
        { type: "STARTED", at: ts },
        { type: "RETRY", at: ts, error: "TIMEOUT" },
        {
          type: "RETRY",
          at: ts,
          error: "SCHEMA_INVALID",
          repair_attempt: true,
        },
        { type: "BLOCKED", at: ts },
      ]),
    ).toEqual({
      status: "BLOCKED",
      retry_count: 2,
      repair_count: 1,
    });
  });

  test("[STARTED, SKIPPED, OK] → OK, 0, 0", () => {
    expect(
      foldEvents([
        { type: "STARTED", at: ts },
        { type: "SKIPPED", at: ts, reason: "idempotent" },
        { type: "OK", at: ts },
      ]),
    ).toEqual({
      status: "OK",
      retry_count: 0,
      repair_count: 0,
    });
  });

  test("[STARTED, RECOVERED, OK] → OK, 0, 0", () => {
    expect(
      foldEvents([
        { type: "STARTED", at: ts },
        { type: "RECOVERED", at: ts },
        { type: "OK", at: ts },
      ]),
    ).toEqual({
      status: "OK",
      retry_count: 0,
      repair_count: 0,
    });
  });

  test("[STARTED, RETRY, RECOVERED, OK] → OK, 1, 0", () => {
    expect(
      foldEvents([
        { type: "STARTED", at: ts },
        { type: "RETRY", at: ts, error: "TIMEOUT" },
        { type: "RECOVERED", at: ts },
        { type: "OK", at: ts },
      ]),
    ).toEqual({
      status: "OK",
      retry_count: 1,
      repair_count: 0,
    });
  });

  test("[STARTED, RETRY] → RUNNING, 1, 0 (incomplete sequence)", () => {
    expect(
      foldEvents([
        { type: "STARTED", at: ts },
        { type: "RETRY", at: ts, error: "TIMEOUT" },
      ]),
    ).toEqual({
      status: "RUNNING",
      retry_count: 1,
      repair_count: 0,
    });
  });
});

describe("applyEventFold", () => {
  test("overwrites status/retry_count/repair_count from events", () => {
    const step = makeStep({
      status: "RUNNING",
      retry_count: 0,
      repair_count: 0,
      events: [
        { type: "STARTED", at: ts },
        { type: "RETRY", at: ts, error: "TIMEOUT" },
        {
          type: "RETRY",
          at: ts,
          error: "SCHEMA_INVALID",
          repair_attempt: true,
        },
        { type: "OK", at: ts },
      ],
    });

    const result = applyEventFold(step);

    expect(result.status).toBe("OK");
    expect(result.retry_count).toBe(2);
    expect(result.repair_count).toBe(1);
    // Mutates in place
    expect(result).toBe(step);
  });

  test("logs drift via console.debug when stored != derived", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});

    const step = makeStep({
      status: "RUNNING",
      retry_count: 0,
      repair_count: 0,
      events: [
        { type: "STARTED", at: ts },
        { type: "RETRY", at: ts, error: "TIMEOUT" },
        { type: "OK", at: ts },
      ],
    });

    applyEventFold(step);

    // status: RUNNING → OK (drift)
    // retry_count: 0 → 1 (drift)
    // repair_count: 0 → 0 (no drift)
    expect(debugSpy).toHaveBeenCalledTimes(2);
    expect(debugSpy).toHaveBeenCalledWith(
      expect.stringContaining("status stored=RUNNING derived=OK"),
    );
    expect(debugSpy).toHaveBeenCalledWith(
      expect.stringContaining("retry_count stored=0 derived=1"),
    );

    debugSpy.mockRestore();
  });

  test("no log when stored matches derived", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});

    const step = makeStep({
      status: "OK",
      retry_count: 1,
      repair_count: 0,
      events: [
        { type: "STARTED", at: ts },
        { type: "RETRY", at: ts, error: "TIMEOUT" },
        { type: "OK", at: ts },
      ],
    });

    applyEventFold(step);

    expect(debugSpy).not.toHaveBeenCalled();

    debugSpy.mockRestore();
  });

  test("does not modify error_code", () => {
    const step = makeStep({
      status: "RUNNING",
      retry_count: 0,
      repair_count: 0,
      error_code: "TIMEOUT",
      events: [
        { type: "STARTED", at: ts },
        { type: "FAILED", at: ts },
      ],
    });

    applyEventFold(step);

    expect(step.error_code).toBe("TIMEOUT");
  });
});
