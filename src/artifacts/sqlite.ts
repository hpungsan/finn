import Database, {
  type Database as DatabaseType,
  type Statement,
} from "better-sqlite3";
import { ulid } from "ulid";
import { ArtifactError } from "./errors.js";
import { normalize } from "./normalize.js";
import type { ArtifactStore } from "./store.js";
import type {
  Artifact,
  ArtifactRef,
  ComposeOpts,
  ComposeResult,
  DeleteOpts,
  FetchOpts,
  ListOpts,
  ListResult,
  StoreOpts,
} from "./types.js";

const MAX_DATA_CHARS = 200_000;
const MAX_TEXT_CHARS = 12_000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const EXPIRED_PURGE_INTERVAL_MS = 5 * 60 * 1000;
const EXPIRED_PURGE_BATCH_LIMIT = 100;

interface SqliteArtifactStoreOptions {
  dbPath: string; // ":memory:" for tests, file path for production
}

/**
 * SQLite implementation of ArtifactStore.
 * Production-ready with WAL mode and proper indexing.
 */
export class SqliteArtifactStore implements ArtifactStore {
  private db: DatabaseType;
  private lastExpiredPurgeAtMs: number | null = null;
  private stmts: {
    fetchById: Statement;
    fetchActiveByName: Statement;
    fetchAnyByName: Statement;
    insertArtifact: Statement;
    updateArtifact: Statement;
    updateArtifactWithVersion: Statement;
    softDelete: Statement;
    softDeleteExpired: Statement;
    softDeleteExpiredBatch: Statement;
  };

  constructor(opts: SqliteArtifactStoreOptions) {
    this.db = new Database(opts.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 3000");
    this.initSchema();
    this.stmts = this.prepareStatements();
  }

  close(): void {
    this.db.close();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS artifacts (
        id              TEXT PRIMARY KEY,

        -- Identity (raw + normalized)
        workspace_raw   TEXT NOT NULL DEFAULT 'default',
        workspace_norm  TEXT NOT NULL DEFAULT 'default',
        name_raw        TEXT,
        name_norm       TEXT,

        -- Content
        kind            TEXT NOT NULL,
        data_json       TEXT NOT NULL,
        text            TEXT,
        data_chars      INTEGER NOT NULL,
        text_chars      INTEGER,

        -- Orchestration
        run_id          TEXT,
        phase           TEXT,
        role            TEXT,
        tags_json       TEXT,
        schema_version  TEXT,

        -- Lifecycle
        version         INTEGER NOT NULL DEFAULT 1,
        ttl_seconds     INTEGER,
        expires_at      INTEGER,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL,
        deleted_at      INTEGER
      );

      CREATE UNIQUE INDEX IF NOT EXISTS ux_artifacts_workspace_name ON artifacts(workspace_norm, name_norm)
        WHERE name_norm IS NOT NULL AND deleted_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_artifacts_run_id ON artifacts(run_id) WHERE deleted_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_artifacts_workspace_kind ON artifacts(workspace_norm, kind) WHERE deleted_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_artifacts_expires ON artifacts(expires_at) WHERE expires_at IS NOT NULL AND deleted_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_artifacts_updated ON artifacts(updated_at DESC) WHERE deleted_at IS NULL;
    `);
  }

  private prepareStatements() {
    return {
      fetchById: this.db.prepare(`
        SELECT * FROM artifacts WHERE id = ?
      `),
      fetchActiveByName: this.db.prepare(`
        SELECT * FROM artifacts
        WHERE workspace_norm = ? AND name_norm = ? AND deleted_at IS NULL
        ORDER BY id DESC
        LIMIT 1
      `),
      fetchAnyByName: this.db.prepare(`
        SELECT * FROM artifacts
        WHERE workspace_norm = ? AND name_norm = ?
        ORDER BY (deleted_at IS NULL) DESC, updated_at DESC, id DESC
        LIMIT 1
      `),
      insertArtifact: this.db.prepare(`
        INSERT INTO artifacts (
          id, workspace_raw, workspace_norm, name_raw, name_norm,
          kind, data_json, text, data_chars, text_chars,
          run_id, phase, role, tags_json, schema_version,
          version, ttl_seconds, expires_at, created_at, updated_at
        ) VALUES (
          @id, @workspace_raw, @workspace_norm, @name_raw, @name_norm,
          @kind, @data_json, @text, @data_chars, @text_chars,
          @run_id, @phase, @role, @tags_json, @schema_version,
          @version, @ttl_seconds, @expires_at, @created_at, @updated_at
        )
      `),
      updateArtifact: this.db.prepare(`
        UPDATE artifacts SET
          workspace_raw = @workspace_raw,
          workspace_norm = @workspace_norm,
          name_raw = @name_raw,
          name_norm = @name_norm,
          kind = @kind,
          data_json = @data_json,
          text = @text,
          data_chars = @data_chars,
          text_chars = @text_chars,
          run_id = @run_id,
          phase = @phase,
          role = @role,
          tags_json = @tags_json,
          schema_version = @schema_version,
          version = @version,
          ttl_seconds = @ttl_seconds,
          expires_at = @expires_at,
          created_at = @created_at,
          updated_at = @updated_at
        WHERE id = @id
      `),
      updateArtifactWithVersion: this.db.prepare(`
        UPDATE artifacts SET
          workspace_raw = @workspace_raw,
          workspace_norm = @workspace_norm,
          name_raw = @name_raw,
          name_norm = @name_norm,
          kind = @kind,
          data_json = @data_json,
          text = @text,
          data_chars = @data_chars,
          text_chars = @text_chars,
          run_id = @run_id,
          phase = @phase,
          role = @role,
          tags_json = @tags_json,
          schema_version = @schema_version,
          version = version + 1,
          ttl_seconds = @ttl_seconds,
          expires_at = @expires_at,
          updated_at = @updated_at
        WHERE workspace_norm = @workspace_norm
          AND name_norm = @name_norm
          AND version = @expected_version
          AND (expires_at IS NULL OR expires_at > @now)
          AND deleted_at IS NULL
      `),
      softDelete: this.db.prepare(`
        UPDATE artifacts SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL
      `),
      softDeleteExpired: this.db.prepare(`
        UPDATE artifacts SET deleted_at = ?
        WHERE workspace_norm = ? AND name_norm = ?
          AND expires_at IS NOT NULL AND expires_at <= ?
          AND deleted_at IS NULL
      `),
      softDeleteExpiredBatch: this.db.prepare(`
        UPDATE artifacts
        SET deleted_at = @deleted_at
        WHERE id IN (
          SELECT id
          FROM artifacts
          WHERE expires_at IS NOT NULL
            AND expires_at <= @now
            AND deleted_at IS NULL
          LIMIT @limit
        )
      `),
    };
  }

  /** Convert SQL null to undefined for optional fields */
  private nullToUndefined<T>(value: T | null): T | undefined {
    return value === null ? undefined : value;
  }

  private rowToArtifact(row: Record<string, unknown>): Artifact {
    return {
      id: row.id as string,
      workspace: row.workspace_raw as string,
      workspace_norm: row.workspace_norm as string,
      name: this.nullToUndefined(row.name_raw as string | null),
      name_norm: this.nullToUndefined(row.name_norm as string | null),
      kind: row.kind as string,
      data: JSON.parse(row.data_json as string),
      text: this.nullToUndefined(row.text as string | null),
      run_id: this.nullToUndefined(row.run_id as string | null),
      phase: this.nullToUndefined(row.phase as string | null),
      role: this.nullToUndefined(row.role as string | null),
      tags: row.tags_json ? JSON.parse(row.tags_json as string) : undefined,
      schema_version: this.nullToUndefined(row.schema_version as string | null),
      version: row.version as number,
      ttl_seconds: this.nullToUndefined(row.ttl_seconds as number | null),
      expires_at: this.nullToUndefined(row.expires_at as number | null),
      created_at: row.created_at as number,
      updated_at: row.updated_at as number,
      deleted_at: this.nullToUndefined(row.deleted_at as number | null),
    };
  }

  private isExpired(row: Record<string, unknown>): boolean {
    const expiresAt = row.expires_at as number | undefined;
    if (expiresAt === undefined || expiresAt === null) return false;
    return expiresAt <= Date.now();
  }

  private isDeleted(row: Record<string, unknown>): boolean {
    return row.deleted_at !== undefined && row.deleted_at !== null;
  }

  private maybePurgeExpired(now: number): void {
    if (
      this.lastExpiredPurgeAtMs !== null &&
      now - this.lastExpiredPurgeAtMs < EXPIRED_PURGE_INTERVAL_MS
    ) {
      return;
    }

    this.stmts.softDeleteExpiredBatch.run({
      deleted_at: now,
      now,
      limit: EXPIRED_PURGE_BATCH_LIMIT,
    });
    this.lastExpiredPurgeAtMs = now;
  }

  private validateRef(
    ref: ArtifactRef,
  ): { byId: string } | { byName: { workspace: string; name: string } } {
    const hasId = ref.id !== undefined;
    const hasName = ref.name !== undefined;
    const hasWorkspace = ref.workspace !== undefined;

    if (hasId && hasName) {
      throw new ArtifactError(
        "AMBIGUOUS_ADDRESSING",
        "Cannot specify both id and name",
      );
    }
    if (!hasId && !hasName) {
      throw new ArtifactError(
        "INVALID_REQUEST",
        "Must specify either id or name",
      );
    }
    if (hasName && !hasWorkspace) {
      throw new ArtifactError(
        "INVALID_REQUEST",
        "Must specify workspace when using name",
      );
    }

    if (hasId) {
      return { byId: ref.id as string };
    }
    return {
      byName: { workspace: ref.workspace as string, name: ref.name as string },
    };
  }

  async store(opts: StoreOpts): Promise<Artifact> {
    const dataJson = JSON.stringify(opts.data);
    if (dataJson.length > MAX_DATA_CHARS) {
      throw new ArtifactError(
        "DATA_TOO_LARGE",
        `data exceeds ${MAX_DATA_CHARS} chars`,
      );
    }
    if (opts.text !== undefined && opts.text.length > MAX_TEXT_CHARS) {
      throw new ArtifactError(
        "TEXT_TOO_LARGE",
        `text exceeds ${MAX_TEXT_CHARS} chars`,
      );
    }

    const workspace = opts.workspace ?? "default";
    const workspaceNorm = normalize(workspace);
    const nameNorm = opts.name !== undefined ? normalize(opts.name) : undefined;
    const now = Date.now();

    this.maybePurgeExpired(now);

    // Optimistic locking path (update)
    if (opts.expected_version !== undefined) {
      if (opts.name === undefined || nameNorm === undefined) {
        throw new ArtifactError(
          "INVALID_REQUEST",
          "expected_version requires name",
        );
      }

      const params = {
        workspace_raw: workspace,
        workspace_norm: workspaceNorm,
        name_raw: opts.name,
        name_norm: nameNorm,
        kind: opts.kind,
        data_json: dataJson,
        text: opts.text ?? null,
        data_chars: dataJson.length,
        text_chars: opts.text?.length ?? null,
        run_id: opts.run_id ?? null,
        phase: opts.phase ?? null,
        role: opts.role ?? null,
        tags_json: opts.tags ? JSON.stringify(opts.tags) : null,
        schema_version: opts.schema_version ?? null,
        ttl_seconds:
          opts.ttl_seconds === null ? null : (opts.ttl_seconds ?? null),
        expires_at:
          opts.ttl_seconds != null ? now + opts.ttl_seconds * 1000 : null,
        updated_at: now,
        now,
        expected_version: opts.expected_version,
      };

      const result = this.stmts.updateArtifactWithVersion.run(params);

      if (result.changes === 0) {
        // Check why it failed: not found or version mismatch
        const existing = this.stmts.fetchActiveByName.get(
          workspaceNorm,
          nameNorm,
        ) as Record<string, unknown> | undefined;

        if (!existing || this.isDeleted(existing)) {
          throw new ArtifactError("NOT_FOUND", "Artifact not found");
        }
        if (this.isExpired(existing)) {
          throw new ArtifactError("NOT_FOUND", "Artifact not found");
        }
        throw new ArtifactError(
          "VERSION_MISMATCH",
          `Expected version ${opts.expected_version}, got ${existing.version}`,
        );
      }

      // Fetch the updated artifact
      const updated = this.stmts.fetchActiveByName.get(
        workspaceNorm,
        nameNorm,
      ) as Record<string, unknown>;
      return this.rowToArtifact(updated);
    }

    // Create/replace path
    const mode = opts.mode ?? "error";

    // Check for existing artifact by name
    if (opts.name !== undefined && nameNorm !== undefined) {
      const existing = this.stmts.fetchActiveByName.get(
        workspaceNorm,
        nameNorm,
      ) as Record<string, unknown> | undefined;

      if (existing && !this.isDeleted(existing)) {
        if (this.isExpired(existing)) {
          // Handle expired artifact collision: soft-delete the expired artifact and insert a fresh one atomically.
          const id = ulid();
          const insertParams = {
            id,
            workspace_raw: workspace,
            workspace_norm: workspaceNorm,
            name_raw: opts.name,
            name_norm: nameNorm,
            kind: opts.kind,
            data_json: dataJson,
            text: opts.text ?? null,
            data_chars: dataJson.length,
            text_chars: opts.text?.length ?? null,
            run_id: opts.run_id ?? null,
            phase: opts.phase ?? null,
            role: opts.role ?? null,
            tags_json: opts.tags ? JSON.stringify(opts.tags) : null,
            schema_version: opts.schema_version ?? null,
            version: 1,
            ttl_seconds:
              opts.ttl_seconds === null ? null : (opts.ttl_seconds ?? null),
            expires_at:
              opts.ttl_seconds != null ? now + opts.ttl_seconds * 1000 : null,
            created_at: now,
            updated_at: now,
          };

          const tx = this.db.transaction(() => {
            this.stmts.softDeleteExpired.run(now, workspaceNorm, nameNorm, now);
            this.stmts.insertArtifact.run(insertParams);
          });

          try {
            tx();
          } catch (err) {
            if ((err as Error).message?.includes("UNIQUE constraint failed")) {
              throw new ArtifactError(
                "NAME_ALREADY_EXISTS",
                `Artifact with name "${opts.name}" already exists in workspace "${workspace}"`,
              );
            }
            throw err;
          }

          const created = this.stmts.fetchById.get(id) as Record<
            string,
            unknown
          >;
          return this.rowToArtifact(created);
        } else {
          // Active artifact exists
          if (mode === "error") {
            throw new ArtifactError(
              "NAME_ALREADY_EXISTS",
              `Artifact with name "${opts.name}" already exists in workspace "${workspace}"`,
            );
          }
          // mode === "replace": overwrite
          const nextVersion = (existing.version as number) + 1;
          const params = {
            id: existing.id as string,
            workspace_raw: workspace,
            workspace_norm: workspaceNorm,
            name_raw: opts.name,
            name_norm: nameNorm,
            kind: opts.kind,
            data_json: dataJson,
            text: opts.text ?? null,
            data_chars: dataJson.length,
            text_chars: opts.text?.length ?? null,
            run_id: opts.run_id ?? null,
            phase: opts.phase ?? null,
            role: opts.role ?? null,
            tags_json: opts.tags ? JSON.stringify(opts.tags) : null,
            schema_version: opts.schema_version ?? null,
            version: nextVersion,
            ttl_seconds:
              opts.ttl_seconds === null ? null : (opts.ttl_seconds ?? null),
            expires_at:
              opts.ttl_seconds != null ? now + opts.ttl_seconds * 1000 : null,
            created_at: existing.created_at as number,
            updated_at: now,
          };

          this.stmts.updateArtifact.run(params);
          const replaced = this.stmts.fetchById.get(existing.id) as Record<
            string,
            unknown
          >;
          return this.rowToArtifact(replaced);
        }
      }
    }

    // Create new artifact
    const id = ulid();
    const params = {
      id,
      workspace_raw: workspace,
      workspace_norm: workspaceNorm,
      name_raw: opts.name ?? null,
      name_norm: nameNorm ?? null,
      kind: opts.kind,
      data_json: dataJson,
      text: opts.text ?? null,
      data_chars: dataJson.length,
      text_chars: opts.text?.length ?? null,
      run_id: opts.run_id ?? null,
      phase: opts.phase ?? null,
      role: opts.role ?? null,
      tags_json: opts.tags ? JSON.stringify(opts.tags) : null,
      schema_version: opts.schema_version ?? null,
      version: 1,
      ttl_seconds:
        opts.ttl_seconds === null ? null : (opts.ttl_seconds ?? null),
      expires_at:
        opts.ttl_seconds != null ? now + opts.ttl_seconds * 1000 : null,
      created_at: now,
      updated_at: now,
    };

    try {
      this.stmts.insertArtifact.run(params);
    } catch (err) {
      // Handle race condition where another process inserted with same name
      if ((err as Error).message?.includes("UNIQUE constraint failed")) {
        throw new ArtifactError(
          "NAME_ALREADY_EXISTS",
          `Artifact with name "${opts.name}" already exists in workspace "${workspace}"`,
        );
      }
      throw err;
    }

    const created = this.stmts.fetchById.get(id) as Record<string, unknown>;
    return this.rowToArtifact(created);
  }

  async fetch(opts: FetchOpts): Promise<Artifact | null> {
    const addr = this.validateRef(opts);

    let row: Record<string, unknown> | undefined;

    if ("byId" in addr) {
      row = this.stmts.fetchById.get(addr.byId) as
        | Record<string, unknown>
        | undefined;
    } else {
      const workspaceNorm = normalize(addr.byName.workspace);
      const nameNorm = normalize(addr.byName.name);
      row = (
        opts.include_deleted
          ? this.stmts.fetchAnyByName
          : this.stmts.fetchActiveByName
      ).get(workspaceNorm, nameNorm) as Record<string, unknown> | undefined;
    }

    if (!row) return null;

    // Filter by deleted
    if (this.isDeleted(row) && !opts.include_deleted) {
      return null;
    }

    // Filter by expired
    if (this.isExpired(row) && !opts.include_expired) {
      return null;
    }

    return this.rowToArtifact(row);
  }

  async list(opts: ListOpts): Promise<ListResult> {
    const limit = Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const offset = opts.offset ?? 0;
    const orderBy = opts.order_by ?? "updated_at";

    // Build WHERE clause dynamically
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (!opts.include_deleted) {
      conditions.push("deleted_at IS NULL");
    }

    if (!opts.include_expired) {
      conditions.push("(expires_at IS NULL OR expires_at > ?)");
      params.push(Date.now());
    }

    if (opts.workspace !== undefined) {
      conditions.push("workspace_norm = ?");
      params.push(normalize(opts.workspace));
    }

    if (opts.kind !== undefined) {
      conditions.push("kind = ?");
      params.push(opts.kind);
    }

    if (opts.run_id !== undefined) {
      conditions.push("run_id = ?");
      params.push(opts.run_id);
    }

    if (opts.phase !== undefined) {
      conditions.push("phase = ?");
      params.push(opts.phase);
    }

    if (opts.role !== undefined) {
      conditions.push("role = ?");
      params.push(opts.role);
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const orderColumn = orderBy === "created_at" ? "created_at" : "updated_at";

    // Fetch limit + 1 to detect has_more
    const sql = `
      SELECT * FROM artifacts
      ${whereClause}
      ORDER BY ${orderColumn} DESC, id DESC
      LIMIT ? OFFSET ?
    `;

    params.push(limit + 1, offset);

    const rows = this.db.prepare(sql).all(...params) as Record<
      string,
      unknown
    >[];

    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map((row) => {
      const artifact = this.rowToArtifact(row);
      // Strip text from results
      const { text: _, ...rest } = artifact;
      return rest;
    });

    return {
      items,
      pagination: {
        limit,
        offset,
        has_more: hasMore,
      },
    };
  }

  async compose(opts: ComposeOpts): Promise<ComposeResult> {
    const format = opts.format ?? "markdown";

    // Fetch all artifacts in input order
    const artifacts: Artifact[] = [];
    for (const ref of opts.items) {
      const addr = this.validateRef(ref);

      let row: Record<string, unknown> | undefined;

      if ("byId" in addr) {
        row = this.stmts.fetchById.get(addr.byId) as
          | Record<string, unknown>
          | undefined;
      } else {
        const workspaceNorm = normalize(addr.byName.workspace);
        const nameNorm = normalize(addr.byName.name);
        row = this.stmts.fetchActiveByName.get(workspaceNorm, nameNorm) as
          | Record<string, unknown>
          | undefined;
      }

      // Exclude deleted and expired
      if (row) {
        if (this.isDeleted(row) || this.isExpired(row)) {
          row = undefined;
        }
      }

      if (!row) {
        const identifier =
          "byId" in addr
            ? addr.byId
            : `${addr.byName.workspace}/${addr.byName.name}`;
        throw new ArtifactError(
          "NOT_FOUND",
          `Artifact not found: ${identifier}`,
        );
      }

      artifacts.push(this.rowToArtifact(row));
    }

    if (format === "json") {
      return {
        format: "json",
        parts: artifacts.map((a) => ({
          id: a.id,
          name: a.name,
          data: a.data,
        })),
      };
    }

    // Markdown format: requires text
    const sections: string[] = [];
    for (const artifact of artifacts) {
      if (artifact.text === undefined) {
        const identifier = artifact.name ?? artifact.id;
        throw new ArtifactError(
          "COMPOSE_MISSING_TEXT",
          `Artifact "${identifier}" has no text`,
        );
      }

      // Build header with fallbacks
      let header: string;
      const hasRole = artifact.role !== undefined;
      const hasName = artifact.name !== undefined;

      if (hasRole && hasName) {
        header = `## ${artifact.kind}: ${artifact.role} (${artifact.name})`;
      } else if (hasRole && !hasName) {
        header = `## ${artifact.kind}: ${artifact.role} (${artifact.id})`;
      } else if (!hasRole && hasName) {
        header = `## ${artifact.kind} (${artifact.name})`;
      } else {
        header = `## ${artifact.kind} (${artifact.id})`;
      }

      sections.push(`${header}\n\n${artifact.text}\n\n---`);
    }

    return {
      format: "markdown",
      bundle_text: sections.join("\n\n"),
    };
  }

  async delete(opts: DeleteOpts): Promise<void> {
    const addr = this.validateRef(opts);

    if ("byId" in addr) {
      this.stmts.softDelete.run(Date.now(), addr.byId);
    } else {
      const workspaceNorm = normalize(addr.byName.workspace);
      const nameNorm = normalize(addr.byName.name);

      // Fetch the artifact first to get its ID
      const row = this.stmts.fetchActiveByName.get(workspaceNorm, nameNorm) as
        | Record<string, unknown>
        | undefined;
      if (row && !this.isDeleted(row)) {
        this.stmts.softDelete.run(Date.now(), row.id);
      }
    }
  }
}
