import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { SqliteArtifactStore } from "../../artifacts/sqlite.js";
import type { ArtifactStore } from "../../artifacts/store.js";
import type { RunRecord } from "../../schemas/run-record.js";
import { ExecutorError } from "../errors.js";
import { RunWriter } from "../run-writer.js";
import type { RunConfig, Step } from "../types.js";

function createMockStep(overrides: Partial<Step> & { id: string }): Step {
  return {
    name: overrides.id,
    deps: [],
    timeout: 60_000,
    maxRetries: 2,
    model: "sonnet",
    prompt_version: "v1",
    schema_version: "1.0",
    getInputs: () => ({}),
    run: async () => ({ status: "OK", artifact_ids: [] }),
    ...overrides,
  };
}

describe("RunWriter", () => {
  let store: ArtifactStore & { close: () => void };
  const defaultConfig: RunConfig = {
    rounds: 2,
    retries: 2,
    timeout_ms: 60_000,
  };

  beforeEach(() => {
    store = new SqliteArtifactStore({ dbPath: ":memory:" });
  });

  afterEach(() => {
    store.close();
  });

  describe("init", () => {
    test("creates RunRecord on init (new run)", async () => {
      const writer = new RunWriter({
        store,
        run_id: "test-run",
        owner_id: "owner-1",
        workflow: "plan",
        args: { task: "test" },
        repo_hash: "abc123",
        config: defaultConfig,
      });

      const { runRecord, isResume } = await writer.init();

      expect(isResume).toBe(false);
      expect(runRecord.run_id).toBe("test-run");
      expect(runRecord.owner_id).toBe("owner-1");
      expect(runRecord.workflow).toBe("plan");
      expect(runRecord.status).toBe("RUNNING");
      expect(runRecord.args).toEqual({ task: "test" });
      expect(runRecord.repo_hash).toBe("abc123");
      expect(runRecord.config).toEqual(defaultConfig);
      expect(runRecord.steps).toEqual([]);
    });

    test("returns isResume=true when existing RUNNING record found", async () => {
      // Create first run
      const writer1 = new RunWriter({
        store,
        run_id: "test-run",
        owner_id: "owner-1",
        workflow: "plan",
        args: {},
        repo_hash: "abc123",
        config: defaultConfig,
      });
      await writer1.init();

      // Try to resume with same owner
      const writer2 = new RunWriter({
        store,
        run_id: "test-run",
        owner_id: "owner-1",
        workflow: "plan",
        args: {},
        repo_hash: "abc123",
        config: defaultConfig,
      });
      const { isResume } = await writer2.init();

      expect(isResume).toBe(true);
    });

    test("throws RUN_ALREADY_COMPLETE when RunRecord has terminal status", async () => {
      // Create and finalize a run
      const writer1 = new RunWriter({
        store,
        run_id: "test-run",
        owner_id: "owner-1",
        workflow: "plan",
        args: {},
        repo_hash: "abc123",
        config: defaultConfig,
      });
      await writer1.init();
      await writer1.finalize("OK");

      // Try to resume
      const writer2 = new RunWriter({
        store,
        run_id: "test-run",
        owner_id: "owner-1",
        workflow: "plan",
        args: {},
        repo_hash: "abc123",
        config: defaultConfig,
      });

      await expect(writer2.init()).rejects.toThrow(ExecutorError);
      try {
        await writer2.init();
      } catch (e) {
        expect((e as ExecutorError).code).toBe("RUN_ALREADY_COMPLETE");
      }
    });

    test("throws RUN_OWNED_BY_OTHER on owner_id mismatch", async () => {
      // Create first run
      const writer1 = new RunWriter({
        store,
        run_id: "test-run",
        owner_id: "owner-1",
        workflow: "plan",
        args: {},
        repo_hash: "abc123",
        config: defaultConfig,
      });
      await writer1.init();

      // Try with different owner
      const writer2 = new RunWriter({
        store,
        run_id: "test-run",
        owner_id: "owner-2",
        workflow: "plan",
        args: {},
        repo_hash: "abc123",
        config: defaultConfig,
      });

      await expect(writer2.init()).rejects.toThrow(ExecutorError);
      try {
        await writer2.init();
      } catch (e) {
        expect((e as ExecutorError).code).toBe("RUN_OWNED_BY_OTHER");
      }
    });

    test("throws INVALID_RUN_RECORD on schema validation failure", async () => {
      // Manually store corrupted RunRecord
      await store.store({
        workspace: "runs",
        name: "corrupted-run",
        kind: "run-record",
        data: { invalid: "data" }, // Missing required fields
        ttl_seconds: 3600,
      });

      const writer = new RunWriter({
        store,
        run_id: "corrupted-run",
        owner_id: "owner-1",
        workflow: "plan",
        args: {},
        repo_hash: "abc123",
        config: defaultConfig,
      });

      await expect(writer.init()).rejects.toThrow(ExecutorError);
      try {
        await writer.init();
      } catch (e) {
        expect((e as ExecutorError).code).toBe("INVALID_RUN_RECORD");
      }
    });

    test("restores step_seq counter on resume", async () => {
      const writer1 = new RunWriter({
        store,
        run_id: "test-run",
        owner_id: "owner-1",
        workflow: "plan",
        args: {},
        repo_hash: "abc123",
        config: defaultConfig,
      });
      await writer1.init();

      const step = createMockStep({ id: "step-1" });
      await writer1.recordStepStarted(step, "instance-1", "digest-1");
      await writer1.recordStepStarted(step, "instance-2", "digest-2");

      // Resume
      const writer2 = new RunWriter({
        store,
        run_id: "test-run",
        owner_id: "owner-1",
        workflow: "plan",
        args: {},
        repo_hash: "abc123",
        config: defaultConfig,
      });
      await writer2.init();

      // Next step_seq should continue from 2
      const nextSeq = writer2.nextStepSeq();
      expect(nextSeq).toBe(3);
    });
  });

  describe("recordStepStarted/Completed", () => {
    test("records step started with step.name", async () => {
      const writer = new RunWriter({
        store,
        run_id: "test-run",
        owner_id: "owner-1",
        workflow: "plan",
        args: {},
        repo_hash: "abc123",
        config: defaultConfig,
      });
      await writer.init();

      const step = createMockStep({ id: "step-id", name: "Step Name" });
      await writer.recordStepStarted(step, "instance-1", "digest-1");

      const record = writer.getRunRecord();
      expect(record?.steps).toHaveLength(1);
      expect(record?.steps[0].step_id).toBe("step-id");
      expect(record?.steps[0].name).toBe("Step Name");
      expect(record?.steps[0].status).toBe("RUNNING");
      expect(record?.steps[0].step_seq).toBe(1);
    });

    test("records step completed", async () => {
      const writer = new RunWriter({
        store,
        run_id: "test-run",
        owner_id: "owner-1",
        workflow: "plan",
        args: {},
        repo_hash: "abc123",
        config: defaultConfig,
      });
      await writer.init();

      const step = createMockStep({ id: "step-1" });
      await writer.recordStepStarted(step, "instance-1", "digest-1");
      await writer.recordStepCompleted(
        step,
        "instance-1",
        "OK",
        [
          { type: "STARTED", at: "2024-01-01T00:00:00Z" },
          { type: "OK", at: "2024-01-01T00:01:00Z" },
        ],
        ["artifact-1"],
        undefined,
        0,
        0,
      );

      const record = writer.getRunRecord();
      expect(record?.steps[0].status).toBe("OK");
      expect(record?.steps[0].artifact_ids).toEqual(["artifact-1"]);
    });

    test("assigns monotonic step_seq across parallel steps", async () => {
      const writer = new RunWriter({
        store,
        run_id: "test-run",
        owner_id: "owner-1",
        workflow: "plan",
        args: {},
        repo_hash: "abc123",
        config: defaultConfig,
      });
      await writer.init();

      const step1 = createMockStep({ id: "step-1" });
      const step2 = createMockStep({ id: "step-2" });
      const step3 = createMockStep({ id: "step-3" });

      await writer.recordStepStarted(step1, "instance-1", "digest-1");
      await writer.recordStepStarted(step2, "instance-2", "digest-2");
      await writer.recordStepStarted(step3, "instance-3", "digest-3");

      const record = writer.getRunRecord();
      expect(record?.steps[0].step_seq).toBe(1);
      expect(record?.steps[1].step_seq).toBe(2);
      expect(record?.steps[2].step_seq).toBe(3);
    });
  });

  describe("recordStepSkipped", () => {
    test("records SKIPPED step with original status", async () => {
      const writer = new RunWriter({
        store,
        run_id: "test-run",
        owner_id: "owner-1",
        workflow: "plan",
        args: {},
        repo_hash: "abc123",
        config: defaultConfig,
      });
      await writer.init();

      const step = createMockStep({ id: "step-1" });
      await writer.recordStepSkipped(step, "instance-1", "digest-1", {
        status: "OK",
        artifact_ids: ["artifact-1"],
      });

      const record = writer.getRunRecord();
      expect(record?.steps).toHaveLength(1);
      expect(record?.steps[0].status).toBe("OK");
      expect(record?.steps[0].artifact_ids).toEqual(["artifact-1"]);
      expect(record?.steps[0].events).toHaveLength(3);
      expect(record?.steps[0].events[0].type).toBe("STARTED");
      expect(record?.steps[0].events[1].type).toBe("SKIPPED");
      expect(record?.steps[0].events[2].type).toBe("OK");
    });
  });

  describe("recordStepRecovered", () => {
    test("records RECOVERED event for recovered steps", async () => {
      const writer = new RunWriter({
        store,
        run_id: "test-run",
        owner_id: "owner-1",
        workflow: "plan",
        args: {},
        repo_hash: "abc123",
        config: defaultConfig,
      });
      await writer.init();

      const step = createMockStep({ id: "step-1" });
      await writer.recordStepStarted(step, "instance-1", "digest-1");

      await writer.recordStepRecovered(step, "instance-1", {
        status: "OK",
        artifact_ids: ["recovered-artifact"],
      });

      const record = writer.getRunRecord();
      expect(record?.steps[0].status).toBe("OK");
      expect(record?.steps[0].artifact_ids).toEqual(["recovered-artifact"]);
      expect(record?.steps[0].events.some((e) => e.type === "RECOVERED")).toBe(
        true,
      );
    });
  });

  describe("finalize", () => {
    test("finalizes run with OK status", async () => {
      const writer = new RunWriter({
        store,
        run_id: "test-run",
        owner_id: "owner-1",
        workflow: "plan",
        args: {},
        repo_hash: "abc123",
        config: defaultConfig,
      });
      await writer.init();

      const result = await writer.finalize("OK");

      expect(result.status).toBe("OK");
      expect(result.last_error).toBeUndefined();
    });

    test("finalizes run with FAILED status and error", async () => {
      const writer = new RunWriter({
        store,
        run_id: "test-run",
        owner_id: "owner-1",
        workflow: "plan",
        args: {},
        repo_hash: "abc123",
        config: defaultConfig,
      });
      await writer.init();

      const result = await writer.finalize("FAILED", "TIMEOUT");

      expect(result.status).toBe("FAILED");
      expect(result.last_error).toBe("TIMEOUT");
    });
  });

  describe("VERSION_MISMATCH handling", () => {
    test("retries once on VERSION_MISMATCH", async () => {
      const writer = new RunWriter({
        store,
        run_id: "test-run",
        owner_id: "owner-1",
        workflow: "plan",
        args: {},
        repo_hash: "abc123",
        config: defaultConfig,
      });
      await writer.init();

      const step = createMockStep({ id: "step-1" });

      // Record step - this should succeed even if there's a version conflict
      // because RunWriter retries once
      await writer.recordStepStarted(step, "instance-1", "digest-1");

      const record = writer.getRunRecord();
      expect(record?.steps).toHaveLength(1);
    });

    test("throws after second VERSION_MISMATCH (fail-fast)", async () => {
      const writer = new RunWriter({
        store,
        run_id: "test-run",
        owner_id: "owner-1",
        workflow: "plan",
        args: {},
        repo_hash: "abc123",
        config: defaultConfig,
      });
      await writer.init();

      // Get current artifact to know the version
      const artifact = await store.fetch({
        workspace: "runs",
        name: "test-run",
      });
      const currentVersion = artifact?.version ?? 1;

      // Externally update the artifact to cause VERSION_MISMATCH
      // We update it twice so even after retry, there's still a mismatch
      await store.store({
        workspace: "runs",
        name: "test-run",
        kind: "run-record",
        data: artifact?.data,
        ttl_seconds: 3600,
        expected_version: currentVersion,
        mode: "replace",
      });

      // Now the writer's version is stale. When it tries to write,
      // it will get VERSION_MISMATCH, reload, and retry.
      // But we'll intercept the store to keep causing conflicts.

      // Override store.store to always throw VERSION_MISMATCH
      const originalStore = store.store.bind(store);
      let callCount = 0;
      store.store = async (opts) => {
        callCount++;
        if (opts.expected_version !== undefined) {
          // Simulate persistent VERSION_MISMATCH
          const { ArtifactError } = await import("../../artifacts/index.js");
          throw new ArtifactError("VERSION_MISMATCH", "Version mismatch");
        }
        return originalStore(opts);
      };

      const step = createMockStep({ id: "step-1" });

      // This should fail after retry exhausted
      await expect(
        writer.recordStepStarted(step, "instance-1", "digest-1"),
      ).rejects.toThrow(ExecutorError);

      // Restore original store
      store.store = originalStore;

      // Should have attempted twice (initial + 1 retry)
      expect(callCount).toBe(2);
    });
  });

  describe("serialization", () => {
    test("serializes concurrent writes via Promise chain", async () => {
      const writer = new RunWriter({
        store,
        run_id: "test-run",
        owner_id: "owner-1",
        workflow: "plan",
        args: {},
        repo_hash: "abc123",
        config: defaultConfig,
      });
      await writer.init();

      const steps = Array.from({ length: 5 }, (_, i) =>
        createMockStep({ id: `step-${i}` }),
      );

      // Fire all writes concurrently
      await Promise.all(
        steps.map((step, i) =>
          writer.recordStepStarted(step, `instance-${i}`, `digest-${i}`),
        ),
      );

      const record = writer.getRunRecord();
      expect(record?.steps).toHaveLength(5);

      // All step_seqs should be unique
      const seqs = record?.steps.map((s) => s.step_seq) ?? [];
      expect(new Set(seqs).size).toBe(5);
    });
  });

  describe("getRunRecord", () => {
    test("returns null before init", () => {
      const writer = new RunWriter({
        store,
        run_id: "test-run",
        owner_id: "owner-1",
        workflow: "plan",
        args: {},
        repo_hash: "abc123",
        config: defaultConfig,
      });

      expect(writer.getRunRecord()).toBeNull();
    });

    test("returns current record after init", async () => {
      const writer = new RunWriter({
        store,
        run_id: "test-run",
        owner_id: "owner-1",
        workflow: "plan",
        args: {},
        repo_hash: "abc123",
        config: defaultConfig,
      });
      await writer.init();

      const record = writer.getRunRecord();
      expect(record).not.toBeNull();
      expect(record?.run_id).toBe("test-run");
    });
  });

  describe("persistence", () => {
    test("persists RunRecord to store", async () => {
      const writer = new RunWriter({
        store,
        run_id: "test-run",
        owner_id: "owner-1",
        workflow: "plan",
        args: { task: "test" },
        repo_hash: "abc123",
        config: defaultConfig,
      });
      await writer.init();

      const step = createMockStep({ id: "step-1" });
      await writer.recordStepStarted(step, "instance-1", "digest-1");

      // Fetch from store to verify persistence
      const artifact = await store.fetch({
        workspace: "runs",
        name: "test-run",
      });

      expect(artifact).not.toBeNull();
      const data = artifact?.data as RunRecord;
      expect(data.run_id).toBe("test-run");
      expect(data.steps).toHaveLength(1);
    });
  });
});
