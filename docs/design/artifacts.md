# Artifacts

> Finn's durable state layer for workflow orchestration.
> Typed JSON with TTL, versioning, and indexing.

---

## Overview

Artifacts provide durable, structured state for Finn's workflow orchestration. Unlike Moss capsules (designed for human/LLM session handoffs), artifacts are optimized for **code consumers** that need:

- Typed JSON data for programmatic operations (sort, filter, dedupe)
- TTL-based lifecycle management
- Optimistic concurrency control
- Namespace isolation
- Text views for LLM subagent consumption

**Key principle:** The artifact store owns storage semantics. Finn owns meaning.

```
finn/src/artifacts/ (storage layer)
├── Storage semantics: TTL, versioning, indexing, compose
├── Generic operations: store, fetch, list, compose, delete
└── No domain-specific logic

finn/src/ (domain layer)
├── schemas/       # Zod validation per artifact kind
├── policies/      # TTL policies (what TTL for what kind)
├── renderers/     # Text renderers (how to render data as markdown)
└── workflows/     # Orchestration logic
```

---

## Library API

### ArtifactStore Interface

```typescript
interface ArtifactStore {
  store(opts: StoreOpts): Promise<Artifact>;
  fetch(opts: FetchOpts): Promise<Artifact | null>;
  list(opts: ListOpts): Promise<ListResult>;
  compose(opts: ComposeOpts): Promise<ComposeResult>;
  delete(opts: DeleteOpts): Promise<void>;
}
```

### Implementations

| Implementation | Use Case |
|----------------|----------|
| `SqliteArtifactStore` | Production — persistent storage |
| `InMemoryArtifactStore` | Tests — no external dependencies |

```typescript
import { SqliteArtifactStore } from "./artifacts/sqlite";
import { InMemoryArtifactStore } from "./artifacts/memory";

// Production
const store = new SqliteArtifactStore({ dbPath: "~/.finn/artifacts.db" });

// Tests
const store = new InMemoryArtifactStore();
```

---

## Core Types

### Artifact

```typescript
interface Artifact<T = unknown> {
  // Identity
  id: string;                    // ULID, auto-generated
  workspace: string;             // namespace as provided (default: "default")
  workspace_norm: string;        // normalized for uniqueness/lookup
  name?: string;                 // unique handle as provided
  name_norm?: string;            // normalized for uniqueness/lookup

  // Content
  kind: string;                  // artifact type (e.g., "run-record", "explorer-finding")
  data: T;                       // structured JSON (validated by caller)
  text?: string;                 // rendered view for LLMs (provided by caller)

  // Orchestration
  run_id?: string;               // groups artifacts for one workflow run
  phase?: string;                // workflow stage
  role?: string;                 // agent role
  tags?: string[];               // categorization
  schema_version?: string;       // content schema version (e.g., "explorer-finding@1")

  // Lifecycle
  version: number;               // optimistic concurrency (starts at 1)
  ttl_seconds?: number;          // time-to-live (null = no expiry)
  expires_at?: number;           // computed: created_at + ttl_seconds
  created_at: number;            // Unix timestamp (ms)
  updated_at: number;
  deleted_at?: number;           // soft delete
}
```

### Operation Types

```typescript
type StoreOpts = {
  workspace?: string;            // default: "default"
  name?: string;                 // unique handle (optional)
  kind: string;                  // required
  data: unknown;                 // required (caller validates before calling)
  text?: string;                 // optional rendered view
  run_id?: string;
  phase?: string;
  role?: string;
  tags?: string[];
  ttl_seconds?: number | null;   // null = no expiry
  expected_version?: number;     // optimistic locking
  mode?: "error" | "replace";    // default: "error"
};

type FetchOpts = {
  id?: string;                   // by ID
  workspace?: string;            // by name (requires workspace)
  name?: string;
  include_expired?: boolean;
  include_deleted?: boolean;
};

type ListOpts = {
  workspace?: string;
  kind?: string;
  run_id?: string;
  phase?: string;
  role?: string;
  include_expired?: boolean;
  include_deleted?: boolean;
  order_by?: "created_at" | "updated_at";  // default: "updated_at", always with id tie-breaker
  limit?: number;                // default: 50, max: 100
  offset?: number;
};

type ListResult = {
  items: Artifact[];             // includes data, excludes text
  pagination: { limit: number; offset: number; has_more: boolean };
};

type ComposeOpts = {
  items: Array<{ id?: string; workspace?: string; name?: string }>;
  format?: "markdown" | "json";  // default: "markdown"
};

type ComposeResult =
  | { bundle_text: string }                                    // markdown (requires text)
  | { parts: Array<{ id: string; name?: string; data: unknown }> };  // json (data only)

type DeleteOpts = {
  id?: string;
  workspace?: string;
  name?: string;
};
```

---

## Storage Semantics

### Name/Workspace Normalization

Artifacts use raw + normalized addressing to prevent collisions while preserving display casing.

**Normalization rules:**
1. Trim leading/trailing whitespace
2. Lowercase
3. Collapse internal whitespace to single spaces
4. Preserve all other characters (underscores, hyphens, etc.)

No character translation: `my-name` stays `my-name`, `my_name` stays `my_name`.

```
"  My Workspace  " → "my workspace"
"AUTH_SYSTEM"      → "auth_system"
"Run-123-Explorer" → "run-123-explorer"
```

**Lookup uses normalized; display uses raw.** Storing `name: "Code-Explorer"` allows queries to match `"code-explorer"`, but responses return `"Code-Explorer"`.

**Unique constraint:** `UNIQUE(workspace_norm, name_norm)` — two artifacts with names that normalize identically cannot coexist.

### Store Behavior

| `expected_version` | `mode` | Artifact exists | Result |
|--------------------|--------|-----------------|--------|
| not set | `"error"` (default) | no | Create |
| not set | `"error"` | yes | `NAME_ALREADY_EXISTS` |
| not set | `"replace"` | no | Create |
| not set | `"replace"` | yes | Overwrite (last-write-wins) |
| set | (ignored) | no | `NOT_FOUND` |
| set | (ignored) | version matches | Update, version++ |
| set | (ignored) | version mismatch | `VERSION_MISMATCH` |

**When `expected_version` provided (optimistic locking):**
- Artifact must exist → `NOT_FOUND` if missing
- Version must match → `VERSION_MISMATCH` if different
- `mode` is ignored

**When `expected_version` not provided:**
- `mode: "error"` (default): fail with `NAME_ALREADY_EXISTS` if name exists
- `mode: "replace"`: overwrite if exists, create if not

**Replace semantics:** True replace — all fields overwritten. Omitted optional fields are cleared, not preserved. For partial updates, use fetch-merge-store: fetch current artifact, merge changes, store with `expected_version`.

**Name omitted:** Always creates new artifact with auto-generated ID.

**Atomic updates:** Optimistic locking must be implemented as a single atomic UPDATE, not read-then-write:
```sql
UPDATE artifacts SET ..., version = version + 1
WHERE workspace_norm=? AND name_norm=? AND version=? AND deleted_at IS NULL
```
Check `changes() == 1`. If 0, query to distinguish `NOT_FOUND` vs `VERSION_MISMATCH`. Single statement = no race window.

### Version Semantics

| Operation | `version` | `updated_at` |
|-----------|-----------|--------------|
| `store` (create) | = 1 | = now |
| `store` (update) | += 1 | = now |

### Timestamp Units

All timestamps are **milliseconds** (Unix epoch):
- `created_at`, `updated_at`, `deleted_at`, `expires_at` — milliseconds
- `ttl_seconds` — seconds (as named)

Expiration formula: `expires_at = created_at + (ttl_seconds * 1000)`

Mixing units causes "everything expired instantly" bugs.

### TTL and Expiration

**On store:** If `ttl_seconds` provided, compute `expires_at = now_ms + (ttl_seconds * 1000)`.

**On read/list/fetch:** Filter out expired artifacts by default (`expires_at < now`).

**Expiration cleanup:** Lazy filter + opportunistic batch purge on writes.

```typescript
// Read path: filter only, no delete
WHERE (expires_at IS NULL OR expires_at > ?)

// Write path (throttled, every 5 min): soft-delete expired
UPDATE artifacts SET deleted_at = ?
WHERE expires_at IS NOT NULL AND expires_at < ? AND deleted_at IS NULL
LIMIT 100;
```

**Expired artifact collision:** Expired artifacts don't block new stores. On collision with expired artifact:
1. Soft-delete the expired artifact
2. Insert new artifact with fresh ID

This must be transactional (BEGIN/COMMIT) to avoid race conditions.

### List Behavior

**Deterministic ordering:** Always use tie-breaker for stable results:
```sql
ORDER BY updated_at DESC, id DESC
-- or
ORDER BY created_at DESC, id DESC
```

Without tie-breaker, rows with same timestamp return in undefined order across queries. This breaks fan-in determinism and test stability.

### Compose Behavior

Bundles artifact text views into single context for LLM consumption.

**Markdown format (default):**
```markdown
## {kind}: {role} ({name})

{text}

---
```

**Fallbacks:**
- `role` missing → `## {kind} ({name})`
- `name` missing → `## {kind}: {role} ({id})`
- Both missing → `## {kind} ({id})`

**Error handling:**
- Markdown format: `COMPOSE_MISSING_TEXT` if any artifact has no `text` (LLM consumption requires text)
- JSON format: `text` not required (returns `data` only for code consumers)

**Ordering:** Compose preserves input order. Output appears in same order as `items` array. Do not let SQL reorder — fetch by ID list, then assemble in input order.

---

## Error Codes

| Code | Cause |
|------|-------|
| `VERSION_MISMATCH` | `expected_version` doesn't match current |
| `NAME_ALREADY_EXISTS` | `mode: "error"` and name exists |
| `NOT_FOUND` | Artifact doesn't exist |
| `INVALID_REQUEST` | Invalid parameter combination |
| `AMBIGUOUS_ADDRESSING` | Both `id` AND `workspace + name` provided |
| `DATA_TOO_LARGE` | `data` exceeds 200K chars (ceiling; Finn enforces kind-specific limits) |
| `TEXT_TOO_LARGE` | `text` exceeds 12K chars |
| `COMPOSE_MISSING_TEXT` | Artifact in items has no `text` |

```typescript
import { ArtifactError, ErrorCode } from "./artifacts/errors";

try {
  await store.store({ ... });
} catch (e) {
  if (e instanceof ArtifactError && e.code === "VERSION_MISMATCH") {
    // Handle conflict
  }
}
```

---

## SQLite Schema

```sql
-- WAL mode for better concurrent reads during writes
PRAGMA journal_mode=WAL;
-- Wait up to 3s for locks instead of immediate SQLITE_BUSY
PRAGMA busy_timeout=3000;

CREATE TABLE artifacts (
    id              TEXT PRIMARY KEY,  -- ULID

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
    tags_json       TEXT,  -- JSON array
    schema_version  TEXT,  -- content schema version (e.g., "explorer-finding@1")

    -- Lifecycle
    version         INTEGER NOT NULL DEFAULT 1,
    ttl_seconds     INTEGER,
    expires_at      INTEGER,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    deleted_at      INTEGER
);

-- Indexes
CREATE UNIQUE INDEX ux_artifacts_workspace_name ON artifacts(workspace_norm, name_norm)
    WHERE name_norm IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX idx_artifacts_run_id ON artifacts(run_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_artifacts_workspace_kind ON artifacts(workspace_norm, kind) WHERE deleted_at IS NULL;
CREATE INDEX idx_artifacts_expires ON artifacts(expires_at) WHERE expires_at IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX idx_artifacts_updated ON artifacts(updated_at DESC) WHERE deleted_at IS NULL;
```

---

## Usage Examples

### Basic Operations

```typescript
import { SqliteArtifactStore } from "./artifacts/sqlite";

const store = new SqliteArtifactStore({ dbPath: "./artifacts.db" });

// Store
const artifact = await store.store({
  workspace: "runs",
  name: "run-123",
  kind: "run-record",
  data: { status: "running", steps: [] },
  ttl_seconds: 7 * 24 * 3600,  // 7 days
});

// Fetch
const fetched = await store.fetch({ workspace: "runs", name: "run-123" });

// Update with optimistic locking
await store.store({
  workspace: "runs",
  name: "run-123",
  kind: "run-record",
  data: { ...fetched.data, status: "complete" },
  expected_version: fetched.version,
});

// List
const { items } = await store.list({
  workspace: "runs",
  kind: "run-record",
  limit: 10,
});

// Delete
await store.delete({ workspace: "runs", name: "run-123" });
```

### Fan-out / Fan-in Pattern

```typescript
const run_id = "plan-auth-1234";

// Fan-out: Multiple agents store findings
await store.store({
  workspace: "plan",
  name: `${run_id}-code-explorer`,
  kind: "explorer-finding",
  data: codeExplorerOutput,              // Validated with Zod before store
  text: renderExplorerFinding(output),   // Rendered by caller
  run_id,
  role: "code-explorer",
  ttl_seconds: 3600,
});

// Fan-in: Gather all findings
const { items } = await store.list({ run_id, kind: "explorer-finding" });

// Code operates on structured data
const allFiles = items.flatMap(f => f.data.files);
const sorted = allFiles.sort((a, b) => b.relevance - a.relevance);

// Compose for LLM consumption
const { bundle_text } = await store.compose({
  items: items.map(f => ({ id: f.id })),
  format: "markdown",
});
```

### Cross-Round Memory

```typescript
// Round 1: Store verifier output
await store.store({
  workspace: "feat",
  name: `${run_id}-verifier-r1`,
  kind: "verifier-output",
  data: { verdict: "concerns", issues: [...] },
  text: renderVerifierOutput(output),
  run_id,
  role: "impl-verifier",
  ttl_seconds: 7200,
});

// Round 2: Fetch previous, compare
const prev = await store.fetch({
  workspace: "feat",
  name: `${run_id}-verifier-r1`,
});
const resolved = prev.data.issues.filter(i => !currentIssues.has(i.id));
```

---

## Project Structure

```
finn/
├── src/
│   ├── artifacts/
│   │   ├── index.ts              # Public exports
│   │   ├── types.ts              # Artifact, StoreOpts, etc.
│   │   ├── errors.ts             # ArtifactError, ErrorCode
│   │   ├── store.ts              # ArtifactStore interface
│   │   ├── sqlite.ts             # SqliteArtifactStore
│   │   ├── memory.ts             # InMemoryArtifactStore
│   │   ├── normalize.ts          # Name/workspace normalization
│   │   └── schema.sql            # SQLite schema
│   ├── schemas/                  # Zod schemas for artifact kinds
│   │   ├── explorer-finding.ts
│   │   ├── verifier-output.ts
│   │   ├── run-record.ts
│   │   └── dlq-entry.ts
│   ├── policies/
│   │   └── ttl.ts                # TTL constants per workspace/kind
│   ├── renderers/
│   │   ├── explorer.ts           # renderExplorerFinding()
│   │   ├── verifier.ts           # renderVerifierOutput()
│   │   └── index.ts
│   └── workflows/
│       ├── plan.ts
│       ├── feat.ts
│       └── fix.ts
```

---

## Design Principles

### 1. Semantics-Light Storage

The artifact store provides storage mechanics, not domain logic:
- No schema validation (caller validates with Zod before store)
- No text rendering (caller provides text)
- No TTL policies (caller decides ttl_seconds per call)
- No kind-specific behavior

**Import boundary:** `src/artifacts/` must not import from `workflows/`, `schemas/`, `policies/`, `renderers/`, or `subagents/`. This keeps extraction trivial.

### 2. Workspace Namespacing

Use workspace prefixes to organize artifacts by workflow:
```typescript
workspace: "plan"       // Explorer findings (1 hour TTL)
workspace: "feat"       // Verifier outputs, design specs (2 hour TTL)
workspace: "runs"       // Run records (7-30 day TTL)
workspace: "dlq"        // DLQ entries (persistent)
```

### 3. Data is Truth, Text is View

```
data (JSON) ──→ source of truth, code operates on this
      │
      ▼
text (markdown) ─→ derived view for LLMs, caller provides
```

`list()` returns `data` for code operations. `compose()` bundles `text` for LLM consumption.

### 4. Optimistic Concurrency

`version` + `expected_version` enables safe read-modify-write:
```typescript
const current = await store.fetch({ ... });
await store.store({
  ...opts,
  data: modify(current.data),
  expected_version: current.version,  // Fails if changed
});
```

---

## Relationship to Moss

Finn artifacts and Moss capsules share **design patterns** but no code dependency:

| Pattern | Shared? | Notes |
|---------|---------|-------|
| Workspace namespacing | Yes | Same concept, independent implementations |
| Orchestration fields (run_id, phase, role) | Yes | Same fields for workflow coordination |
| Normalization rules | Yes | Same algorithm for name collision prevention |
| TTL/lifecycle | Artifacts only | Capsules are persistent |
| Optimistic locking | Artifacts only | Capsules use last-write-wins |
| Compose operation | Artifacts only | Capsules have different bundling needs |

**The boundary:** Moss provides capsules for LLM session handoffs. Finn owns its orchestration state via this internal artifact store.

