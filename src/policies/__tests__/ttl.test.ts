import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ArtifactError, SqliteArtifactStore } from "../../artifacts/index.js";
import {
  getRunRecordTtl,
  KIND_SIZE_LIMITS,
  storeArtifact,
  TTL,
} from "../ttl.js";

describe("TTL policies", () => {
  let store: SqliteArtifactStore;

  beforeEach(() => {
    store = new SqliteArtifactStore({ dbPath: ":memory:" });
  });

  afterEach(() => {
    store.close();
  });

  test("storeArtifact applies workspace TTL", async () => {
    const artifact = await storeArtifact(store, {
      workspace: "plan",
      kind: "explorer-finding",
      data: { files: [], patterns: [], concerns: [], confidence: 0.5 },
    });

    expect(artifact.ttl_seconds).toBe(TTL.EPHEMERAL);
  });

  test("explicit ttl_seconds overrides workspace default", async () => {
    const artifact = await storeArtifact(store, {
      workspace: "plan",
      kind: "explorer-finding",
      data: {},
      ttl_seconds: 9999,
    });

    expect(artifact.ttl_seconds).toBe(9999);
  });

  test("dlq workspace has no expiry", async () => {
    const artifact = await storeArtifact(store, {
      workspace: "dlq",
      kind: "dlq-entry",
      data: {},
    });

    // WORKSPACE_TTL.dlq is null, store converts null to undefined on return
    expect(artifact.ttl_seconds).toBeUndefined();
    expect(artifact.expires_at).toBeUndefined();
  });

  test("explicit null ttl_seconds passes through (not overridden by workspace)", async () => {
    const artifact = await storeArtifact(store, {
      workspace: "plan", // would normally be 1 hour
      kind: "special",
      data: {},
      ttl_seconds: null, // explicitly no expiry
    });

    // null passed through, not overridden by workspace default
    expect(artifact.ttl_seconds).toBeUndefined();
    expect(artifact.expires_at).toBeUndefined();
  });

  test("getRunRecordTtl returns correct values", () => {
    expect(getRunRecordTtl("OK")).toBe(TTL.RUN_SUCCESS);
    expect(getRunRecordTtl("BLOCKED")).toBe(TTL.RUN_FAILURE);
    expect(getRunRecordTtl("FAILED")).toBe(TTL.RUN_FAILURE);
  });

  describe("size limits", () => {
    test("throws DATA_TOO_LARGE when kind exceeds default limit", async () => {
      const largeData = "x".repeat(KIND_SIZE_LIMITS.default + 1);

      await expect(
        storeArtifact(store, {
          kind: "explorer-finding",
          data: largeData,
        }),
      ).rejects.toThrow(ArtifactError);

      try {
        await storeArtifact(store, {
          kind: "explorer-finding",
          data: largeData,
        });
      } catch (e) {
        expect((e as ArtifactError).code).toBe("DATA_TOO_LARGE");
        expect((e as ArtifactError).message).toContain("explorer-finding");
        expect((e as ArtifactError).message).toContain(
          String(KIND_SIZE_LIMITS.default),
        );
      }
    });

    test("run-record has higher limit than default", async () => {
      // Data that exceeds default but fits in run-record limit
      const mediumData = "x".repeat(KIND_SIZE_LIMITS.default + 1000);

      const artifact = await storeArtifact(store, {
        workspace: "runs",
        kind: "run-record",
        data: mediumData,
      });

      expect(artifact.kind).toBe("run-record");
    });

    test("run-record still enforces its own limit", async () => {
      const hugeData = "x".repeat(KIND_SIZE_LIMITS["run-record"] + 1);

      await expect(
        storeArtifact(store, {
          workspace: "runs",
          kind: "run-record",
          data: hugeData,
        }),
      ).rejects.toThrow(ArtifactError);

      try {
        await storeArtifact(store, {
          workspace: "runs",
          kind: "run-record",
          data: hugeData,
        });
      } catch (e) {
        expect((e as ArtifactError).code).toBe("DATA_TOO_LARGE");
      }
    });

    test("allows data at exactly the limit", async () => {
      // Account for JSON stringification overhead (quotes around string)
      const exactData = "x".repeat(KIND_SIZE_LIMITS.default - 2);

      const artifact = await storeArtifact(store, {
        kind: "test-kind",
        data: exactData,
      });

      expect(artifact.data).toBe(exactData);
    });
  });
});
