import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ArtifactError } from "../errors.js";
import { SqliteArtifactStore } from "../sqlite.js";
import type { ArtifactStore } from "../store.js";

describe("SqliteArtifactStore", () => {
  let store: ArtifactStore;

  beforeEach(() => {
    store = new SqliteArtifactStore({ dbPath: ":memory:" });
  });

  afterEach(() => {
    if ("close" in store && typeof store.close === "function") {
      store.close();
    }
  });

  describe("store", () => {
    describe("create", () => {
      test("creates artifact with ULID id", async () => {
        const artifact = await store.store({
          kind: "test-kind",
          data: { foo: "bar" },
        });

        expect(artifact.id).toMatch(/^[0-9A-Z]{26}$/);
      });

      test("uses default workspace when not specified", async () => {
        const artifact = await store.store({
          kind: "test-kind",
          data: { foo: "bar" },
        });

        expect(artifact.workspace).toBe("default");
        expect(artifact.workspace_norm).toBe("default");
      });

      test("normalizes workspace", async () => {
        const artifact = await store.store({
          workspace: "  My Workspace  ",
          kind: "test-kind",
          data: { foo: "bar" },
        });

        expect(artifact.workspace).toBe("  My Workspace  ");
        expect(artifact.workspace_norm).toBe("my workspace");
      });

      test("normalizes name", async () => {
        const artifact = await store.store({
          name: "  My Artifact  ",
          kind: "test-kind",
          data: { foo: "bar" },
        });

        expect(artifact.name).toBe("  My Artifact  ");
        expect(artifact.name_norm).toBe("my artifact");
      });

      test("sets version to 1", async () => {
        const artifact = await store.store({
          kind: "test-kind",
          data: { foo: "bar" },
        });

        expect(artifact.version).toBe(1);
      });

      test("sets created_at and updated_at", async () => {
        const before = Date.now();
        const artifact = await store.store({
          kind: "test-kind",
          data: { foo: "bar" },
        });
        const after = Date.now();

        expect(artifact.created_at).toBeGreaterThanOrEqual(before);
        expect(artifact.created_at).toBeLessThanOrEqual(after);
        expect(artifact.updated_at).toBe(artifact.created_at);
      });

      test("computes expires_at from ttl_seconds", async () => {
        const before = Date.now();
        const artifact = await store.store({
          kind: "test-kind",
          data: { foo: "bar" },
          ttl_seconds: 3600,
        });

        expect(artifact.ttl_seconds).toBe(3600);
        expect(artifact.expires_at).toBeGreaterThanOrEqual(
          before + 3600 * 1000,
        );
      });

      test("null ttl_seconds means no expiry", async () => {
        const artifact = await store.store({
          kind: "test-kind",
          data: { foo: "bar" },
          ttl_seconds: null,
        });

        expect(artifact.ttl_seconds).toBeUndefined();
        expect(artifact.expires_at).toBeUndefined();
      });

      test("stores all optional fields", async () => {
        const artifact = await store.store({
          workspace: "plan",
          name: "test-artifact",
          kind: "explorer-finding",
          data: { files: [] },
          text: "# Explorer Finding",
          run_id: "run-123",
          phase: "explore",
          role: "code-explorer",
          tags: ["auth", "backend"],
          schema_version: "explorer-finding@1",
          ttl_seconds: 3600,
        });

        expect(artifact.workspace).toBe("plan");
        expect(artifact.name).toBe("test-artifact");
        expect(artifact.kind).toBe("explorer-finding");
        expect(artifact.data).toEqual({ files: [] });
        expect(artifact.text).toBe("# Explorer Finding");
        expect(artifact.run_id).toBe("run-123");
        expect(artifact.phase).toBe("explore");
        expect(artifact.role).toBe("code-explorer");
        expect(artifact.tags).toEqual(["auth", "backend"]);
        expect(artifact.schema_version).toBe("explorer-finding@1");
      });
    });

    describe("update with expected_version", () => {
      test("updates when version matches", async () => {
        const created = await store.store({
          workspace: "test",
          name: "artifact",
          kind: "test-kind",
          data: { status: "pending" },
        });

        const updated = await store.store({
          workspace: "test",
          name: "artifact",
          kind: "test-kind",
          data: { status: "complete" },
          expected_version: 1,
        });

        expect(updated.version).toBe(2);
        expect(updated.data).toEqual({ status: "complete" });
        expect(updated.id).toBe(created.id);
        expect(updated.updated_at).toBeGreaterThanOrEqual(created.updated_at);
        expect(updated.created_at).toBe(created.created_at);
      });

      test("refreshes expires_at when ttl_seconds provided on update", async () => {
        const created = await store.store({
          workspace: "test",
          name: "artifact",
          kind: "test-kind",
          data: { status: "pending" },
          ttl_seconds: 1,
        });

        await new Promise((r) => setTimeout(r, 10));

        const updated = await store.store({
          workspace: "test",
          name: "artifact",
          kind: "test-kind",
          data: { status: "complete" },
          expected_version: created.version,
          ttl_seconds: 1,
        });

        expect(updated.created_at).toBe(created.created_at);
        expect(updated.expires_at).toBeDefined();
        expect(created.expires_at).toBeDefined();
        expect(updated.expires_at as number).toBeGreaterThan(
          created.expires_at as number,
        );
      });

      test("throws VERSION_MISMATCH when version differs", async () => {
        await store.store({
          workspace: "test",
          name: "artifact",
          kind: "test-kind",
          data: { status: "pending" },
        });

        await expect(
          store.store({
            workspace: "test",
            name: "artifact",
            kind: "test-kind",
            data: { status: "complete" },
            expected_version: 5,
          }),
        ).rejects.toThrow(ArtifactError);

        try {
          await store.store({
            workspace: "test",
            name: "artifact",
            kind: "test-kind",
            data: { status: "complete" },
            expected_version: 5,
          });
        } catch (e) {
          expect((e as ArtifactError).code).toBe("VERSION_MISMATCH");
        }
      });

      test("throws NOT_FOUND when artifact does not exist", async () => {
        await expect(
          store.store({
            workspace: "test",
            name: "nonexistent",
            kind: "test-kind",
            data: { foo: "bar" },
            expected_version: 1,
          }),
        ).rejects.toThrow(ArtifactError);

        try {
          await store.store({
            workspace: "test",
            name: "nonexistent",
            kind: "test-kind",
            data: { foo: "bar" },
            expected_version: 1,
          });
        } catch (e) {
          expect((e as ArtifactError).code).toBe("NOT_FOUND");
        }
      });

      test("throws NOT_FOUND when artifact is expired", async () => {
        const created = await store.store({
          workspace: "test",
          name: "artifact",
          kind: "test-kind",
          data: { status: "pending" },
          ttl_seconds: 0,
        });

        await new Promise((r) => setTimeout(r, 10));

        await expect(
          store.store({
            workspace: "test",
            name: "artifact",
            kind: "test-kind",
            data: { status: "complete" },
            expected_version: created.version,
          }),
        ).rejects.toThrow(ArtifactError);

        try {
          await store.store({
            workspace: "test",
            name: "artifact",
            kind: "test-kind",
            data: { status: "complete" },
            expected_version: created.version,
          });
        } catch (e) {
          expect((e as ArtifactError).code).toBe("NOT_FOUND");
        }
      });

      test("throws INVALID_REQUEST when expected_version without name", async () => {
        await expect(
          store.store({
            kind: "test-kind",
            data: { foo: "bar" },
            expected_version: 1,
          }),
        ).rejects.toThrow(ArtifactError);

        try {
          await store.store({
            kind: "test-kind",
            data: { foo: "bar" },
            expected_version: 1,
          });
        } catch (e) {
          expect((e as ArtifactError).code).toBe("INVALID_REQUEST");
        }
      });

      test("clears optional fields when not provided (true replace)", async () => {
        await store.store({
          workspace: "test",
          name: "artifact",
          kind: "test-kind",
          data: { foo: "bar" },
          text: "some text",
          run_id: "run-123",
          phase: "explore",
          role: "explorer",
          tags: ["tag1"],
          ttl_seconds: 3600,
        });

        const updated = await store.store({
          workspace: "test",
          name: "artifact",
          kind: "test-kind",
          data: { foo: "baz" },
          expected_version: 1,
        });

        expect(updated.text).toBeUndefined();
        expect(updated.run_id).toBeUndefined();
        expect(updated.phase).toBeUndefined();
        expect(updated.role).toBeUndefined();
        expect(updated.tags).toBeUndefined();
        expect(updated.ttl_seconds).toBeUndefined();
        expect(updated.expires_at).toBeUndefined();
      });
    });

    describe("mode: error", () => {
      test("throws NAME_ALREADY_EXISTS when name exists", async () => {
        await store.store({
          workspace: "test",
          name: "artifact",
          kind: "test-kind",
          data: { v: 1 },
        });

        await expect(
          store.store({
            workspace: "test",
            name: "artifact",
            kind: "test-kind",
            data: { v: 2 },
            mode: "error",
          }),
        ).rejects.toThrow(ArtifactError);

        try {
          await store.store({
            workspace: "test",
            name: "artifact",
            kind: "test-kind",
            data: { v: 2 },
          });
        } catch (e) {
          expect((e as ArtifactError).code).toBe("NAME_ALREADY_EXISTS");
        }
      });

      test("default mode is error", async () => {
        await store.store({
          workspace: "test",
          name: "artifact",
          kind: "test-kind",
          data: { v: 1 },
        });

        try {
          await store.store({
            workspace: "test",
            name: "artifact",
            kind: "test-kind",
            data: { v: 2 },
          });
        } catch (e) {
          expect((e as ArtifactError).code).toBe("NAME_ALREADY_EXISTS");
        }
      });

      test("allows same name in different workspaces", async () => {
        await store.store({
          workspace: "ws1",
          name: "artifact",
          kind: "test-kind",
          data: { v: 1 },
        });

        const artifact = await store.store({
          workspace: "ws2",
          name: "artifact",
          kind: "test-kind",
          data: { v: 2 },
        });

        expect(artifact.workspace).toBe("ws2");
      });

      test("normalized names collide", async () => {
        await store.store({
          workspace: "test",
          name: "My Artifact",
          kind: "test-kind",
          data: { v: 1 },
        });

        try {
          await store.store({
            workspace: "test",
            name: "my artifact",
            kind: "test-kind",
            data: { v: 2 },
          });
        } catch (e) {
          expect((e as ArtifactError).code).toBe("NAME_ALREADY_EXISTS");
        }
      });
    });

    describe("mode: replace", () => {
      test("overwrites existing artifact", async () => {
        const original = await store.store({
          workspace: "test",
          name: "artifact",
          kind: "test-kind",
          data: { v: 1 },
          text: "original",
        });

        const replaced = await store.store({
          workspace: "test",
          name: "artifact",
          kind: "test-kind",
          data: { v: 2 },
          text: "replaced",
          mode: "replace",
        });

        expect(replaced.id).toBe(original.id);
        expect(replaced.data).toEqual({ v: 2 });
        expect(replaced.text).toBe("replaced");
        expect(replaced.version).toBe(original.version + 1);
        expect(replaced.created_at).toBe(original.created_at);
        expect(replaced.updated_at).toBeGreaterThanOrEqual(original.updated_at);
      });

      test("creates if not exists", async () => {
        const artifact = await store.store({
          workspace: "test",
          name: "new-artifact",
          kind: "test-kind",
          data: { v: 1 },
          mode: "replace",
        });

        expect(artifact.name).toBe("new-artifact");
        expect(artifact.version).toBe(1);
      });
    });

    describe("expired artifact collision", () => {
      test("soft-deletes expired artifact and creates new", async () => {
        // Create artifact with immediate expiry
        const expired = await store.store({
          workspace: "test",
          name: "artifact",
          kind: "test-kind",
          data: { v: 1 },
          ttl_seconds: 0, // Expires immediately
        });

        // Wait a moment for expiry
        await new Promise((r) => setTimeout(r, 10));

        // Create new artifact with same name
        const newArtifact = await store.store({
          workspace: "test",
          name: "artifact",
          kind: "test-kind",
          data: { v: 2 },
        });

        expect(newArtifact.id).not.toBe(expired.id);
        expect(newArtifact.data).toEqual({ v: 2 });

        // Old artifact should be soft-deleted
        const fetchedExpired = await store.fetch({
          id: expired.id,
          include_deleted: true,
          include_expired: true,
        });
        expect(fetchedExpired?.deleted_at).toBeDefined();
      });
    });

    describe("size limits", () => {
      test("throws DATA_TOO_LARGE when data exceeds 200K chars", async () => {
        const largeData = "x".repeat(200_001);

        await expect(
          store.store({
            kind: "test-kind",
            data: largeData,
          }),
        ).rejects.toThrow(ArtifactError);

        try {
          await store.store({
            kind: "test-kind",
            data: largeData,
          });
        } catch (e) {
          expect((e as ArtifactError).code).toBe("DATA_TOO_LARGE");
        }
      });

      test("throws TEXT_TOO_LARGE when text exceeds 12K chars", async () => {
        const largeText = "x".repeat(12_001);

        await expect(
          store.store({
            kind: "test-kind",
            data: { foo: "bar" },
            text: largeText,
          }),
        ).rejects.toThrow(ArtifactError);

        try {
          await store.store({
            kind: "test-kind",
            data: { foo: "bar" },
            text: largeText,
          });
        } catch (e) {
          expect((e as ArtifactError).code).toBe("TEXT_TOO_LARGE");
        }
      });

      test("allows data at exactly 200K chars", async () => {
        // Account for JSON stringification overhead
        const dataStr = "x".repeat(199_998);

        const artifact = await store.store({
          kind: "test-kind",
          data: dataStr,
        });

        expect(artifact.data).toBe(dataStr);
      });

      test("allows text at exactly 12K chars", async () => {
        const text = "x".repeat(12_000);

        const artifact = await store.store({
          kind: "test-kind",
          data: { foo: "bar" },
          text,
        });

        expect(artifact.text).toBe(text);
      });
    });
  });

  describe("fetch", () => {
    test("fetches by id", async () => {
      const created = await store.store({
        kind: "test-kind",
        data: { foo: "bar" },
      });

      const fetched = await store.fetch({ id: created.id });

      expect(fetched).toEqual(created);
    });

    test("fetches by workspace + name", async () => {
      const created = await store.store({
        workspace: "test",
        name: "artifact",
        kind: "test-kind",
        data: { foo: "bar" },
      });

      const fetched = await store.fetch({
        workspace: "test",
        name: "artifact",
      });

      expect(fetched).toEqual(created);
    });

    test("fetches by normalized name", async () => {
      await store.store({
        workspace: "Test Workspace",
        name: "My Artifact",
        kind: "test-kind",
        data: { foo: "bar" },
      });

      const fetched = await store.fetch({
        workspace: "test workspace",
        name: "my artifact",
      });

      expect(fetched?.name).toBe("My Artifact");
    });

    test("throws AMBIGUOUS_ADDRESSING when both id and name provided", async () => {
      await expect(
        store.fetch({
          id: "some-id",
          workspace: "test",
          name: "artifact",
        }),
      ).rejects.toThrow(ArtifactError);

      try {
        await store.fetch({
          id: "some-id",
          workspace: "test",
          name: "artifact",
        });
      } catch (e) {
        expect((e as ArtifactError).code).toBe("AMBIGUOUS_ADDRESSING");
      }
    });

    test("throws INVALID_REQUEST when neither id nor name provided", async () => {
      await expect(store.fetch({})).rejects.toThrow(ArtifactError);

      try {
        await store.fetch({});
      } catch (e) {
        expect((e as ArtifactError).code).toBe("INVALID_REQUEST");
      }
    });

    test("throws INVALID_REQUEST when name without workspace", async () => {
      await expect(
        store.fetch({
          name: "artifact",
        }),
      ).rejects.toThrow(ArtifactError);

      try {
        await store.fetch({ name: "artifact" });
      } catch (e) {
        expect((e as ArtifactError).code).toBe("INVALID_REQUEST");
      }
    });

    test("returns null when not found", async () => {
      const result = await store.fetch({ id: "nonexistent" });

      expect(result).toBeNull();
    });

    test("excludes expired by default", async () => {
      const artifact = await store.store({
        workspace: "test",
        name: "artifact",
        kind: "test-kind",
        data: { foo: "bar" },
        ttl_seconds: 0,
      });

      await new Promise((r) => setTimeout(r, 10));

      const fetched = await store.fetch({ id: artifact.id });

      expect(fetched).toBeNull();
    });

    test("includes expired when include_expired is true", async () => {
      const artifact = await store.store({
        workspace: "test",
        name: "artifact",
        kind: "test-kind",
        data: { foo: "bar" },
        ttl_seconds: 0,
      });

      await new Promise((r) => setTimeout(r, 10));

      const fetched = await store.fetch({
        id: artifact.id,
        include_expired: true,
      });

      expect(fetched).not.toBeNull();
    });

    test("excludes deleted by default", async () => {
      const artifact = await store.store({
        workspace: "test",
        name: "artifact",
        kind: "test-kind",
        data: { foo: "bar" },
      });

      await store.delete({ id: artifact.id });

      const fetched = await store.fetch({ id: artifact.id });

      expect(fetched).toBeNull();
    });

    test("includes deleted when include_deleted is true", async () => {
      const artifact = await store.store({
        workspace: "test",
        name: "artifact",
        kind: "test-kind",
        data: { foo: "bar" },
      });

      await store.delete({ id: artifact.id });

      const fetched = await store.fetch({
        id: artifact.id,
        include_deleted: true,
      });

      expect(fetched).not.toBeNull();
      expect(fetched?.deleted_at).toBeDefined();
    });
  });

  describe("list", () => {
    describe("filters", () => {
      test("filters by workspace", async () => {
        await store.store({
          workspace: "ws1",
          name: "a1",
          kind: "test-kind",
          data: {},
        });
        await store.store({
          workspace: "ws2",
          name: "a2",
          kind: "test-kind",
          data: {},
        });

        const result = await store.list({ workspace: "ws1" });

        expect(result.items).toHaveLength(1);
        expect(result.items[0].workspace).toBe("ws1");
      });

      test("filters by normalized workspace", async () => {
        await store.store({
          workspace: "My Workspace",
          name: "a1",
          kind: "test-kind",
          data: {},
        });

        const result = await store.list({ workspace: "my workspace" });

        expect(result.items).toHaveLength(1);
      });

      test("filters by kind", async () => {
        await store.store({ kind: "kind-a", data: {} });
        await store.store({ kind: "kind-b", data: {} });

        const result = await store.list({ kind: "kind-a" });

        expect(result.items).toHaveLength(1);
        expect(result.items[0].kind).toBe("kind-a");
      });

      test("filters by run_id", async () => {
        await store.store({ kind: "test", data: {}, run_id: "run-1" });
        await store.store({ kind: "test", data: {}, run_id: "run-2" });

        const result = await store.list({ run_id: "run-1" });

        expect(result.items).toHaveLength(1);
        expect(result.items[0].run_id).toBe("run-1");
      });

      test("filters by phase", async () => {
        await store.store({ kind: "test", data: {}, phase: "explore" });
        await store.store({ kind: "test", data: {}, phase: "verify" });

        const result = await store.list({ phase: "explore" });

        expect(result.items).toHaveLength(1);
        expect(result.items[0].phase).toBe("explore");
      });

      test("filters by role", async () => {
        await store.store({ kind: "test", data: {}, role: "explorer" });
        await store.store({ kind: "test", data: {}, role: "verifier" });

        const result = await store.list({ role: "explorer" });

        expect(result.items).toHaveLength(1);
        expect(result.items[0].role).toBe("explorer");
      });

      test("combines multiple filters", async () => {
        await store.store({
          workspace: "plan",
          kind: "finding",
          run_id: "run-1",
          role: "explorer",
          data: {},
        });
        await store.store({
          workspace: "plan",
          kind: "finding",
          run_id: "run-2",
          role: "explorer",
          data: {},
        });
        await store.store({
          workspace: "feat",
          kind: "finding",
          run_id: "run-1",
          role: "explorer",
          data: {},
        });

        const result = await store.list({
          workspace: "plan",
          kind: "finding",
          run_id: "run-1",
        });

        expect(result.items).toHaveLength(1);
      });
    });

    describe("ordering", () => {
      test("orders by updated_at DESC by default", async () => {
        const a1 = await store.store({
          workspace: "test",
          name: "a1",
          kind: "test",
          data: {},
        });
        await new Promise((r) => setTimeout(r, 10));
        const a2 = await store.store({
          workspace: "test",
          name: "a2",
          kind: "test",
          data: {},
        });

        const result = await store.list({ workspace: "test" });

        expect(result.items[0].id).toBe(a2.id);
        expect(result.items[1].id).toBe(a1.id);
      });

      test("orders by created_at DESC when specified", async () => {
        const a1 = await store.store({
          workspace: "test",
          name: "a1",
          kind: "test",
          data: {},
        });
        await new Promise((r) => setTimeout(r, 10));
        const a2 = await store.store({
          workspace: "test",
          name: "a2",
          kind: "test",
          data: {},
        });

        // Update a1 to have newer updated_at
        await store.store({
          workspace: "test",
          name: "a1",
          kind: "test",
          data: { updated: true },
          expected_version: 1,
        });

        const result = await store.list({
          workspace: "test",
          order_by: "created_at",
        });

        // a2 was created later, so it comes first
        expect(result.items[0].id).toBe(a2.id);
        expect(result.items[1].id).toBe(a1.id);
      });

      test("uses id as tie-breaker (DESC)", async () => {
        // Create multiple in quick succession (same timestamp possible)
        await Promise.all([
          store.store({ kind: "test", data: { n: 1 } }),
          store.store({ kind: "test", data: { n: 2 } }),
          store.store({ kind: "test", data: { n: 3 } }),
        ]);

        const result = await store.list({});

        // Should be deterministic even if timestamps are the same
        const ids = result.items.map((i) => i.id);
        expect(ids).toHaveLength(3);
        // Later ULIDs are lexicographically greater, so DESC means later first
      });
    });

    describe("pagination", () => {
      test("defaults to limit 50", async () => {
        const result = await store.list({});

        expect(result.pagination.limit).toBe(50);
      });

      test("respects custom limit", async () => {
        for (let i = 0; i < 10; i++) {
          await store.store({ kind: "test", data: { n: i } });
        }

        const result = await store.list({ limit: 3 });

        expect(result.items).toHaveLength(3);
        expect(result.pagination.limit).toBe(3);
      });

      test("caps limit at 100", async () => {
        const result = await store.list({ limit: 200 });

        expect(result.pagination.limit).toBe(100);
      });

      test("respects offset", async () => {
        for (let i = 0; i < 5; i++) {
          await store.store({
            workspace: "test",
            name: `a${i}`,
            kind: "test",
            data: { n: i },
          });
          await new Promise((r) => setTimeout(r, 5));
        }

        const result = await store.list({
          workspace: "test",
          offset: 2,
          limit: 2,
        });

        expect(result.items).toHaveLength(2);
        expect(result.pagination.offset).toBe(2);
      });

      test("returns empty when offset beyond end", async () => {
        for (let i = 0; i < 3; i++) {
          await store.store({ kind: "test", data: { n: i } });
        }

        const result = await store.list({ offset: 10, limit: 5 });

        expect(result.items).toHaveLength(0);
        expect(result.pagination.has_more).toBe(false);
      });

      test("has_more is true when more items exist", async () => {
        for (let i = 0; i < 5; i++) {
          await store.store({ kind: "test", data: { n: i } });
        }

        const result = await store.list({ limit: 3 });

        expect(result.items).toHaveLength(3);
        expect(result.pagination.has_more).toBe(true);
      });

      test("has_more is false at end", async () => {
        for (let i = 0; i < 3; i++) {
          await store.store({ kind: "test", data: { n: i } });
        }

        const result = await store.list({ limit: 10 });

        expect(result.pagination.has_more).toBe(false);
      });
    });

    test("excludes text from items", async () => {
      await store.store({
        kind: "test",
        data: { foo: "bar" },
        text: "some text",
      });

      const result = await store.list({});

      expect(result.items[0]).not.toHaveProperty("text");
      expect(result.items[0].data).toEqual({ foo: "bar" });
    });

    test("excludes expired by default", async () => {
      await store.store({ kind: "test", data: {}, ttl_seconds: 0 });
      await new Promise((r) => setTimeout(r, 10));
      await store.store({ kind: "test", data: {} });

      const result = await store.list({});

      expect(result.items).toHaveLength(1);
    });

    test("includes expired when include_expired is true", async () => {
      await store.store({ kind: "test", data: {}, ttl_seconds: 0 });
      await new Promise((r) => setTimeout(r, 10));
      await store.store({ kind: "test", data: {} });

      const result = await store.list({ include_expired: true });

      expect(result.items).toHaveLength(2);
    });

    test("excludes deleted by default", async () => {
      const artifact = await store.store({
        workspace: "test",
        name: "to-delete",
        kind: "test",
        data: {},
      });
      await store.store({ kind: "test", data: {} });
      await store.delete({ id: artifact.id });

      const result = await store.list({});

      expect(result.items).toHaveLength(1);
    });

    test("includes deleted when include_deleted is true", async () => {
      const artifact = await store.store({
        workspace: "test",
        name: "to-delete",
        kind: "test",
        data: {},
      });
      await store.store({ kind: "test", data: {} });
      await store.delete({ id: artifact.id });

      const result = await store.list({ include_deleted: true });

      expect(result.items).toHaveLength(2);
    });

    test("includes both deleted and expired when include_deleted and include_expired are true", async () => {
      const expired = await store.store({
        workspace: "test",
        name: "expired",
        kind: "test",
        data: { v: 1 },
        ttl_seconds: 0,
      });
      await new Promise((r) => setTimeout(r, 10));

      const deleted = await store.store({
        workspace: "test",
        name: "deleted",
        kind: "test",
        data: { v: 2 },
      });
      await store.delete({ id: deleted.id });

      const active = await store.store({
        workspace: "test",
        name: "active",
        kind: "test",
        data: { v: 3 },
      });

      const result = await store.list({
        include_deleted: true,
        include_expired: true,
      });

      const ids = new Set(result.items.map((i) => i.id));
      expect(ids.has(expired.id)).toBe(true);
      expect(ids.has(deleted.id)).toBe(true);
      expect(ids.has(active.id)).toBe(true);
    });
  });

  describe("compose", () => {
    test("handles empty items", async () => {
      const md = await store.compose({ items: [] });
      expect(md).toEqual({ format: "markdown", bundle_text: "" });

      const json = await store.compose({ items: [], format: "json" });
      expect(json).toEqual({ format: "json", parts: [] });
    });

    describe("markdown format", () => {
      test("bundles text with headers", async () => {
        const a1 = await store.store({
          workspace: "test",
          name: "artifact-1",
          kind: "finding",
          data: {},
          text: "Finding 1 content",
          role: "explorer",
        });
        const a2 = await store.store({
          workspace: "test",
          name: "artifact-2",
          kind: "finding",
          data: {},
          text: "Finding 2 content",
          role: "verifier",
        });

        const result = await store.compose({
          items: [{ id: a1.id }, { id: a2.id }],
        });

        expect(result.format).toBe("markdown");
        if (result.format === "markdown") {
          expect(result.bundle_text).toContain(
            "## finding: explorer (artifact-1)",
          );
          expect(result.bundle_text).toContain("Finding 1 content");
          expect(result.bundle_text).toContain(
            "## finding: verifier (artifact-2)",
          );
          expect(result.bundle_text).toContain("Finding 2 content");
        }
      });

      test("throws COMPOSE_MISSING_TEXT when artifact has no text", async () => {
        const artifact = await store.store({
          workspace: "test",
          name: "no-text",
          kind: "finding",
          data: {},
        });

        await expect(
          store.compose({
            items: [{ id: artifact.id }],
            format: "markdown",
          }),
        ).rejects.toThrow(ArtifactError);

        try {
          await store.compose({
            items: [{ id: artifact.id }],
          });
        } catch (e) {
          expect((e as ArtifactError).code).toBe("COMPOSE_MISSING_TEXT");
        }
      });
    });

    describe("header fallbacks", () => {
      test("full header: kind: role (name)", async () => {
        const a = await store.store({
          workspace: "test",
          name: "my-artifact",
          kind: "finding",
          data: {},
          text: "content",
          role: "explorer",
        });

        const result = await store.compose({
          items: [{ id: a.id }],
        });

        if (result.format === "markdown") {
          expect(result.bundle_text).toContain(
            "## finding: explorer (my-artifact)",
          );
        }
      });

      test("role missing: kind (name)", async () => {
        const a = await store.store({
          workspace: "test",
          name: "my-artifact",
          kind: "finding",
          data: {},
          text: "content",
        });

        const result = await store.compose({
          items: [{ id: a.id }],
        });

        if (result.format === "markdown") {
          expect(result.bundle_text).toContain("## finding (my-artifact)");
        }
      });

      test("name missing: kind: role (id)", async () => {
        const a = await store.store({
          kind: "finding",
          data: {},
          text: "content",
          role: "explorer",
        });

        const result = await store.compose({
          items: [{ id: a.id }],
        });

        if (result.format === "markdown") {
          expect(result.bundle_text).toContain(
            `## finding: explorer (${a.id})`,
          );
        }
      });

      test("both missing: kind (id)", async () => {
        const a = await store.store({
          kind: "finding",
          data: {},
          text: "content",
        });

        const result = await store.compose({
          items: [{ id: a.id }],
        });

        if (result.format === "markdown") {
          expect(result.bundle_text).toContain(`## finding (${a.id})`);
        }
      });
    });

    describe("json format", () => {
      test("returns data only in parts array", async () => {
        const a1 = await store.store({
          workspace: "test",
          name: "artifact-1",
          kind: "finding",
          data: { files: ["a.ts"] },
          text: "some text",
        });
        const a2 = await store.store({
          workspace: "test",
          name: "artifact-2",
          kind: "finding",
          data: { files: ["b.ts"] },
        });

        const result = await store.compose({
          items: [{ id: a1.id }, { id: a2.id }],
          format: "json",
        });

        expect(result.format).toBe("json");
        if (result.format === "json") {
          expect(result.parts).toHaveLength(2);
          expect(result.parts[0].id).toBe(a1.id);
          expect(result.parts[0].name).toBe("artifact-1");
          expect(result.parts[0].data).toEqual({ files: ["a.ts"] });
          expect(result.parts[1].data).toEqual({ files: ["b.ts"] });
        }
      });

      test("text not required for json format", async () => {
        const a = await store.store({
          workspace: "test",
          name: "no-text",
          kind: "finding",
          data: { foo: "bar" },
        });

        const result = await store.compose({
          items: [{ id: a.id }],
          format: "json",
        });

        expect(result.format).toBe("json");
      });
    });

    test("preserves input order", async () => {
      const a1 = await store.store({
        workspace: "test",
        name: "first",
        kind: "test",
        data: { n: 1 },
        text: "First",
      });
      await new Promise((r) => setTimeout(r, 10));
      const a2 = await store.store({
        workspace: "test",
        name: "second",
        kind: "test",
        data: { n: 2 },
        text: "Second",
      });

      // Request in reverse order
      const result = await store.compose({
        items: [{ id: a2.id }, { id: a1.id }],
        format: "json",
      });

      if (result.format === "json") {
        expect(result.parts[0].name).toBe("second");
        expect(result.parts[1].name).toBe("first");
      }
    });

    test("addresses by workspace + name", async () => {
      const a = await store.store({
        workspace: "test",
        name: "my-artifact",
        kind: "test",
        data: { foo: "bar" },
        text: "content",
      });

      const result = await store.compose({
        items: [{ workspace: "test", name: "my-artifact" }],
        format: "json",
      });

      if (result.format === "json") {
        expect(result.parts[0].id).toBe(a.id);
      }
    });

    test("throws AMBIGUOUS_ADDRESSING when both id and name", async () => {
      try {
        await store.compose({
          items: [{ id: "some-id", workspace: "test", name: "some-name" }],
        });
      } catch (e) {
        expect((e as ArtifactError).code).toBe("AMBIGUOUS_ADDRESSING");
      }
    });

    test("throws INVALID_REQUEST when neither id nor name", async () => {
      try {
        await store.compose({
          items: [{}],
        });
      } catch (e) {
        expect((e as ArtifactError).code).toBe("INVALID_REQUEST");
      }
    });

    test("throws NOT_FOUND when artifact does not exist", async () => {
      try {
        await store.compose({
          items: [{ id: "nonexistent" }],
        });
      } catch (e) {
        expect((e as ArtifactError).code).toBe("NOT_FOUND");
      }
    });

    test("throws NOT_FOUND for deleted artifact", async () => {
      const a = await store.store({
        workspace: "test",
        name: "to-delete",
        kind: "test",
        data: {},
        text: "content",
      });
      await store.delete({ id: a.id });

      try {
        await store.compose({
          items: [{ id: a.id }],
        });
      } catch (e) {
        expect((e as ArtifactError).code).toBe("NOT_FOUND");
      }
    });

    test("throws NOT_FOUND for expired artifact", async () => {
      const a = await store.store({
        workspace: "test",
        name: "expired",
        kind: "test",
        data: {},
        text: "content",
        ttl_seconds: 0,
      });
      await new Promise((r) => setTimeout(r, 10));

      try {
        await store.compose({
          items: [{ id: a.id }],
        });
      } catch (e) {
        expect((e as ArtifactError).code).toBe("NOT_FOUND");
      }
    });
  });

  describe("delete", () => {
    test("soft deletes by id", async () => {
      const artifact = await store.store({
        workspace: "test",
        name: "to-delete",
        kind: "test",
        data: {},
      });

      await store.delete({ id: artifact.id });

      const fetched = await store.fetch({
        id: artifact.id,
        include_deleted: true,
      });
      expect(fetched?.deleted_at).toBeDefined();
    });

    test("soft deletes by workspace + name", async () => {
      const artifact = await store.store({
        workspace: "test",
        name: "to-delete",
        kind: "test",
        data: {},
      });

      await store.delete({ workspace: "test", name: "to-delete" });

      const fetched = await store.fetch({
        id: artifact.id,
        include_deleted: true,
      });
      expect(fetched?.deleted_at).toBeDefined();
    });

    test("removes from name index", async () => {
      await store.store({
        workspace: "test",
        name: "to-delete",
        kind: "test",
        data: {},
      });

      await store.delete({ workspace: "test", name: "to-delete" });

      // Should not be found by name
      const fetched = await store.fetch({
        workspace: "test",
        name: "to-delete",
      });
      expect(fetched).toBeNull();

      // Can create new artifact with same name
      const newArtifact = await store.store({
        workspace: "test",
        name: "to-delete",
        kind: "test",
        data: { new: true },
      });
      expect(newArtifact.data).toEqual({ new: true });
    });

    test("throws AMBIGUOUS_ADDRESSING when both id and name", async () => {
      try {
        await store.delete({
          id: "some-id",
          workspace: "test",
          name: "some-name",
        });
      } catch (e) {
        expect((e as ArtifactError).code).toBe("AMBIGUOUS_ADDRESSING");
      }
    });

    test("throws INVALID_REQUEST when neither id nor name", async () => {
      try {
        await store.delete({});
      } catch (e) {
        expect((e as ArtifactError).code).toBe("INVALID_REQUEST");
      }
    });

    test("idempotent: silent success when not found", async () => {
      // Should not throw
      await store.delete({ id: "nonexistent" });
    });

    test("idempotent: no-op when already deleted, preserves deleted_at", async () => {
      const artifact = await store.store({
        workspace: "test",
        name: "to-delete",
        kind: "test",
        data: {},
      });

      await store.delete({ id: artifact.id });

      const afterFirst = await store.fetch({
        id: artifact.id,
        include_deleted: true,
      });
      const firstDeletedAt = afterFirst?.deleted_at;

      await new Promise((r) => setTimeout(r, 10));

      // Delete again
      await store.delete({ id: artifact.id });

      const afterSecond = await store.fetch({
        id: artifact.id,
        include_deleted: true,
      });

      // Original deleted_at should be preserved
      expect(afterSecond?.deleted_at).toBe(firstDeletedAt);
    });
  });

  describe("integration", () => {
    test("end-to-end workflow: create, update, list, compose, delete", async () => {
      // Create explorer findings
      const run_id = "run-123";

      const finding1 = await store.store({
        workspace: "plan",
        name: `${run_id}-code-explorer`,
        kind: "explorer-finding",
        data: { files: ["auth.ts", "login.ts"], relevance: 0.9 },
        text: "# Code Explorer\n\nFound auth-related files.",
        run_id,
        role: "code-explorer",
        ttl_seconds: 3600,
      });

      const finding2 = await store.store({
        workspace: "plan",
        name: `${run_id}-test-explorer`,
        kind: "explorer-finding",
        data: { files: ["auth.test.ts"], relevance: 0.7 },
        text: "# Test Explorer\n\nFound test files.",
        run_id,
        role: "test-explorer",
        ttl_seconds: 3600,
      });

      // List by run_id
      const { items } = await store.list({ run_id });
      expect(items).toHaveLength(2);

      // Code operates on data
      const allFiles = items.flatMap(
        (i) => (i.data as { files: string[] }).files,
      );
      expect(allFiles).toContain("auth.ts");
      expect(allFiles).toContain("auth.test.ts");

      // Compose for LLM consumption
      const { bundle_text } = (await store.compose({
        items: [{ id: finding1.id }, { id: finding2.id }],
      })) as { format: "markdown"; bundle_text: string };

      expect(bundle_text).toContain("code-explorer");
      expect(bundle_text).toContain("test-explorer");

      // Update with optimistic locking
      const updated = await store.store({
        workspace: "plan",
        name: `${run_id}-code-explorer`,
        kind: "explorer-finding",
        data: { files: ["auth.ts", "login.ts", "session.ts"], relevance: 0.95 },
        text: "# Code Explorer\n\nFound more auth-related files.",
        run_id,
        role: "code-explorer",
        expected_version: 1,
      });

      expect(updated.version).toBe(2);
      expect((updated.data as { files: string[] }).files).toContain(
        "session.ts",
      );

      // Delete
      await store.delete({ id: finding1.id });
      await store.delete({ id: finding2.id });

      const afterDelete = await store.list({ run_id });
      expect(afterDelete.items).toHaveLength(0);
    });
  });
});
