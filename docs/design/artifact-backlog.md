# Artifact Backlog

Features and enhancements for the artifact storage layer.

---

## v1 Backlog

Deferred from v1 base to ship lean. Add when needed.

---

### bulkDelete

Batch delete artifacts by filter.

```typescript
bulkDelete(opts: BulkDeleteOpts): Promise<{ deleted: number }>;

type BulkDeleteOpts = {
  // Filters (at least one required)
  workspace?: string;
  kind?: string;
  run_id?: string;
  phase?: string;
  role?: string;
  tag?: string;
};
```

**Use case:** GC artifacts by run_id after completion.

**Workaround:** TTL handles cleanup automatically. Or loop with individual delete() calls.

---

### bulkUpdate

Batch metadata updates across multiple artifacts.

```typescript
bulkUpdate(opts: BulkUpdateOpts): Promise<{ updated: number }>;

type BulkUpdateOpts = {
  // Filters (at least one required)
  workspace?: string;
  kind?: string;
  run_id?: string;
  phase?: string;
  role?: string;
  tag?: string;
  // Updates (at least one required)
  set_phase?: string;
  set_role?: string;
  set_tags?: string[];
  set_ttl_seconds?: number | null;
};
```

**Use case:** Phase transitions (mark all findings as "processed").

**Workaround:** Loop with individual store() calls.

---

### touch

Extend TTL without modifying content.

```typescript
touch(opts: TouchOpts): Promise<void>;

type TouchOpts = {
  id?: string;
  workspace?: string;
  name?: string;
  ttl_seconds: number;
};
```

**Use case:** Keep artifact alive during long-running workflow.

**Workaround:** fetch() then store() with same data and new TTL.

---

### Tag Filtering

Add `tag?: string` to filter opts (`ListOpts`, `BulkDeleteOpts`, `BulkUpdateOpts`).

Requires JSON1 query on `tags_json`:

```sql
WHERE EXISTS (SELECT 1 FROM json_each(artifacts.tags_json) WHERE value = ?)
```

---

## v2 Backlog

---

### FTS5 Text Search

Full-text search across artifact text fields.

```sql
CREATE VIRTUAL TABLE artifacts_fts USING fts5(
    text,
    content='artifacts',
    content_rowid='rowid',
    prefix='2 3 4'
);
```

**Use case:** Search past findings, verifier outputs.

**Why deferred:** Adds complexity (sync triggers, query API). Not needed for v1 workflows.

---

### External Access (MCP Wrapper)

Expose artifact store via MCP for multi-process access.

```typescript
// finn/src/mcp/artifact-tools.ts
server.setRequestHandler("artifact_store", async (params) => {
  return await artifactStore.store(params);
});
```

**Use case:** Another process needs to read/write Finn artifacts.

**Why deferred:** Single-process is sufficient for v1. Add when there's a real consumer.

---

### include_data Option for List

Return metadata only, exclude data payload.

```typescript
type ListOpts = {
  // ... existing fields
  include_data?: boolean;  // default: true
};
```

**Use case:** List artifacts without fetching potentially large data.

**Why deferred:** Current workflows need data for sort/filter/dedupe. Add when listing-only use case appears.
