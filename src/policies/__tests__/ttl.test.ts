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

  describe("numeric TTL requirement", () => {
    test("run-record rejects undefined ttl_seconds", async () => {
      await expect(
        storeArtifact(store, {
          workspace: "runs",
          kind: "run-record",
          data: {},
        }),
      ).rejects.toThrow(ArtifactError);

      try {
        await storeArtifact(store, {
          workspace: "runs",
          kind: "run-record",
          data: {},
        });
      } catch (e) {
        expect((e as ArtifactError).code).toBe("INVALID_REQUEST");
        expect((e as ArtifactError).message).toContain("run-record");
        expect((e as ArtifactError).message).toContain("ttl_seconds");
      }
    });

    test("run-record rejects null ttl_seconds (no permanent runs)", async () => {
      await expect(
        storeArtifact(store, {
          workspace: "runs",
          kind: "run-record",
          data: {},
          ttl_seconds: null,
        }),
      ).rejects.toThrow(ArtifactError);

      try {
        await storeArtifact(store, {
          workspace: "runs",
          kind: "run-record",
          data: {},
          ttl_seconds: null,
        });
      } catch (e) {
        expect((e as ArtifactError).code).toBe("INVALID_REQUEST");
      }
    });

    test("step-result rejects undefined ttl_seconds", async () => {
      await expect(
        storeArtifact(store, {
          workspace: "runs",
          kind: "step-result",
          data: {},
        }),
      ).rejects.toThrow(ArtifactError);

      try {
        await storeArtifact(store, {
          workspace: "runs",
          kind: "step-result",
          data: {},
        });
      } catch (e) {
        expect((e as ArtifactError).code).toBe("INVALID_REQUEST");
      }
    });

    test("step-result rejects null ttl_seconds (no permanent step-results)", async () => {
      await expect(
        storeArtifact(store, {
          workspace: "runs",
          kind: "step-result",
          data: {},
          ttl_seconds: null,
        }),
      ).rejects.toThrow(ArtifactError);

      try {
        await storeArtifact(store, {
          workspace: "runs",
          kind: "step-result",
          data: {},
          ttl_seconds: null,
        });
      } catch (e) {
        expect((e as ArtifactError).code).toBe("INVALID_REQUEST");
      }
    });

    test("run-record works with explicit ttl_seconds", async () => {
      const artifact = await storeArtifact(store, {
        workspace: "runs",
        kind: "run-record",
        data: { run_id: "test" },
        ttl_seconds: getRunRecordTtl("OK"),
      });

      expect(artifact.ttl_seconds).toBe(TTL.RUN_SUCCESS);
    });

    test("step-result works with explicit ttl_seconds", async () => {
      const artifact = await storeArtifact(store, {
        workspace: "runs",
        kind: "step-result",
        data: { status: "OK" },
        ttl_seconds: getRunRecordTtl("FAILED"),
      });

      expect(artifact.ttl_seconds).toBe(TTL.RUN_FAILURE);
    });

    test("rejects NaN ttl_seconds", async () => {
      await expect(
        storeArtifact(store, {
          workspace: "runs",
          kind: "run-record",
          data: {},
          ttl_seconds: NaN,
        }),
      ).rejects.toThrow(ArtifactError);
    });

    test("rejects Infinity ttl_seconds", async () => {
      await expect(
        storeArtifact(store, {
          workspace: "runs",
          kind: "run-record",
          data: {},
          ttl_seconds: Infinity,
        }),
      ).rejects.toThrow(ArtifactError);
    });

    test("rejects negative ttl_seconds", async () => {
      await expect(
        storeArtifact(store, {
          workspace: "runs",
          kind: "run-record",
          data: {},
          ttl_seconds: -1,
        }),
      ).rejects.toThrow(ArtifactError);
    });

    test("rejects zero ttl_seconds", async () => {
      await expect(
        storeArtifact(store, {
          workspace: "runs",
          kind: "run-record",
          data: {},
          ttl_seconds: 0,
        }),
      ).rejects.toThrow(ArtifactError);
    });
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
        ttl_seconds: getRunRecordTtl("OK"), // required for run-record
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
          ttl_seconds: getRunRecordTtl("OK"), // required for run-record
        }),
      ).rejects.toThrow(ArtifactError);

      try {
        await storeArtifact(store, {
          workspace: "runs",
          kind: "run-record",
          data: hugeData,
          ttl_seconds: getRunRecordTtl("OK"),
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
