import { beforeEach, describe, expect, test } from "vitest";
import { SqliteArtifactStore } from "../../artifacts/index.js";
import { getRunRecordTtl, storeArtifact, TTL } from "../ttl.js";

describe("TTL policies", () => {
  let store: SqliteArtifactStore;

  beforeEach(() => {
    store = new SqliteArtifactStore({ dbPath: ":memory:" });
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
});
