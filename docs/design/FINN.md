# Finn: Deterministic Orchestration for Claude Code

> Code-based orchestration exposed via MCP for Claude Code integration.
> Deterministic control flow, enforced limits, auditable execution.

---

## Goals and Non-Goals

### Goals

* **Deterministic orchestration:** control flow, limits, and side effects enforced by code, not suggested by prompts.
* **Guaranteed parallelism:** fan-out/fan-in actually happens, not "hope it happens."
* **Auditable execution:** every step, status, and artifact tracked in Run Records.
* **Testable workflows:** unit test orchestration logic without running models.
* **Structured state:** code operates on typed data, LLMs consume rendered views.
* **Crash recovery:** resume from failed step, not restart from scratch.
* **Same UX:** `/plan`, `/feat`, `/fix` work the same — determinism is invisible to users.

### Non-Goals (v1)

* **Meta-reasoning:** no LLM judgment in orchestration layer.
* **Learned policies:** requires eval harness first.
* **Knowledge persistence:** Lore workspace is v2.
* **Event-driven triggers:** webhooks/cron are v3.

See [BACKLOG.md](../BACKLOG.md) for future scope.

---

## Primitives

| Type | Owner | Scope | Usage |
|------|-------|-------|-------|
| **Artifacts** | Finn | Internal | Explorer findings, verifier outputs, run records, DLQ entries (TTL, code operates on `data`) |
| **Lore** | Finn | Internal | Playbooks, pitfalls, repo maps (persistent artifacts, v2) |
| **Capsules** | Moss | External | Workflow summary, handoff exports (to Claude Code / future sessions) |

Artifacts are Finn's internal state layer. Lore are persistent artifacts (`workspace: "lore"`, no TTL). Capsules are generated on demand for external handoff via Moss.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        CLAUDE CODE                               │
│                                                                  │
│   User: /plan, /feat, /fix                                      │
│          ↓                                                       │
│   Claude invokes MCP tools: finn__plan, finn__feat, finn__fix   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                           FINN                                   │
│                                                                  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                    MCP SERVER                              │  │
│  │  finn__plan, finn__feat, finn__fix                        │  │
│  └─────────────────────────┬─────────────────────────────────┘  │
│                            │                                     │
│                            ▼                                     │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                    WORKFLOWS                               │  │
│  │  plan.ts, feat.ts, fix.ts                                 │  │
│  │  (loops, fan-out/fan-in, error handling)                  │  │
│  └─────────────────────────┬─────────────────────────────────┘  │
│                            │                                     │
│            ┌───────────────┼───────────────┐                    │
│            ▼               ▼               ▼                    │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐            │
│  │  SUBAGENTS   │ │  SUBAGENTS   │ │  SUBAGENTS   │            │
│  │  explorers   │ │  verifiers   │ │  stitcher    │            │
│  └──────┬───────┘ └──────┬───────┘ └──────┬───────┘            │
│         │                │                │                     │
│         └────────────────┼────────────────┘                     │
│                          ▼                                      │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                  ARTIFACT STORE                            │  │
│  │  store(), fetch(), list(), compose()                      │  │
│  │                                                            │  │
│  │  Implementations:                                          │  │
│  │  - SqliteArtifactStore (production + tests)               │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ (on-demand export)
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                          MOSS                                    │
│                                                                  │
│   Capsules → session handoffs for humans/LLMs                   │
└─────────────────────────────────────────────────────────────────┘
```

| Layer | Owns | Does |
|-------|------|------|
| **MCP Server** | Tool definitions | Routes Claude Code calls to workflows |
| **Workflows** | Control flow | Loops, fan-out/fan-in, retries, timeouts |
| **Subagents** | Judgment | Explore, verify, stitch (LLM reasoning) |
| **Artifact Store** | Durable state | Store/fetch/list/compose typed JSON |
| **Moss** | External handoffs | Capsules for session summaries |

---

## Design Principles

### What "Deterministic" Means

LLM outputs are inherently non-deterministic. What Finn guarantees:

| Deterministic | Not Deterministic |
|---------------|-------------------|
| Control flow (loops, branches) | Subagent outputs |
| Enforced limits (rounds, retries, timeouts) | Content of findings |
| Auditable execution (replay tooling in backlog) | LLM reasoning |
| Idempotent side effects | Natural language responses |

**Subagents do the thinking** (non-deterministic). **Code does the routing** (deterministic).

### Code-Based Orchestration

Each workflow is **code** that orchestrates subagents:
- Spawns subagents (explorers, verifiers, stitcher)
- Checks outputs and routes accordingly (proceed / retry / escalate)
- Enforces loop limits deterministically

**Subagents do the thinking** (explore, verify, stitch). **Code does the routing** (loop, branch, aggregate).

### Rounds vs Retries

Separate deliberate improvement cycles from error recovery:

| Concept | Purpose | Example |
|---------|---------|---------|
| **Round** | Quality loop | design → implement → verify |
| **Retry** | Failure recovery | timeout, malformed output, transient error |

**Flags:**
```bash
finn feat plan.md --rounds=2           # 2 quality cycles (default)
finn feat plan.md --rounds=5           # more thorough
finn feat plan.md --retries=3          # per-step failure recovery
```

**Enforcement:** Both are real loops in SDK code. Enforced by code, not suggested by prompts.

| Mode | Default | Enforced by |
|------|---------|-------------|
| `--rounds=N` | 2 | `for` loop |
| `--retries=M` | 2 | try/catch with counter |

### Role Separation

Each agent role sees only what it needs — prevents context pollution:

| Role | Sees | Does NOT see |
|------|------|--------------|
| **Explorers** | Codebase, task description | Other explorers' findings |
| **Stitcher** | Compressed findings, constraints | Raw exploration, tool outputs |
| **Implementer** | Narrow spec, relevant files | Full plan, other files |
| **Verifier** | Diff, spec, prior concerns | Implementation history |

This isolates "execution mess" from planning/synthesis agents.

### Structured Output (Zod Schemas)

Machine-checkable gating, not markdown regex.

**Invariant:** Subagents output JSON → Zod validates → repair retry on failure → store as artifact (`data` + rendered `text`).

**Validation flow:**
1. Subagent returns JSON
2. Validate against schema (e.g., `ExplorerFindingSchema.safeParse()`)
3. If invalid: one repair retry (ask agent to fix output with error details)
4. If still invalid: `BLOCKED` with `SCHEMA_INVALID` error

**Canonical implementations:**
- `src/schemas/explorer-finding.ts` — `ExplorerFindingSchema`
- `src/schemas/run-record.ts` — `RunRecordSchema`, `ErrorCodeSchema`, `StatusSchema`
- `src/schemas/step-result.ts` — `StepRunnerResultSchema`, `PersistedStepResultSchema`
- `src/schemas/dlq-entry.ts` — `DlqEntrySchema`

### Timeout + Retry Policy

Explicit rules, not ad hoc:

| Policy | Value | Enforced by |
|--------|-------|-------------|
| Subagent timeout | 60s default | `withTimeout()` wrapper |
| Max retries | 2 default | `--retries=N` flag |
| Max rounds | 2 default | `--rounds=N` flag |
| Backoff | Exponential + jitter | Code (on RATE_LIMIT, transient errors) |

### Error Taxonomy

Typed error codes for correct retry/backoff/escalation routing:

| Error Code | Retryable | Action |
|------------|-----------|--------|
| `TIMEOUT` | Yes | Retry with same inputs |
| `SCHEMA_INVALID` | Once | Repair retry, then BLOCKED |
| `TOOL_ERROR_TRANSIENT` | Yes | Retry with backoff (network, 429, timeouts) |
| `TOOL_ERROR_PERMANENT` | No | Fail fast (permission denied, invalid args) |
| `RATE_LIMIT` | Yes | Retry with backoff |
| `THRASHING` | No | Stop rounds early |
| `HUMAN_REQUIRED` | No | Escalate |

Typed codes > freeform strings for Run Record analysis.

**Thrashing rule:** If verifier returns same issue fingerprints across 2 consecutive rounds → `THRASHING`, stop rounds early. Fingerprint = `hash(file + category + message)`. Prevents infinite loops on issues the implementer can't resolve.

### Step Interface

First-class abstraction for testable, replayable orchestration. Workflows define steps; engine handles execution uniformly.

**Step fields:**

| Field | Purpose |
|-------|---------|
| `id` | Unique identifier for idempotency |
| `name` | Human-readable name |
| `deps` | Step IDs that must complete first (for topo-sort) |
| `timeout` | Per-step timeout (ms), overrides default |
| `maxRetries` | Per-step retry limit, overrides default |
| `model` | Model to use (e.g., "sonnet") — included in `step_instance_id` |
| `prompt_version` | Prompt template version (e.g., "code-explorer@2") — included in `step_instance_id` |
| `schema_version` | Output schema version (e.g., "explorer-finding@1") — included in `step_instance_id` |
| `getInputs(ctx)` | Pure function returning `StepInputs` for idempotency computation |
| `run(ctx)` | Execute the step, returns `StepRunnerResult` |

**StepContext fields:**

| Field | Purpose |
|-------|---------|
| `run_id` | Current workflow run identifier |
| `store` | Artifact store for persistence |
| `config` | Run configuration (rounds, retries, timeout_ms) |
| `artifacts` | Outputs from completed deps (`Map<string, StepOutput>`: `artifact_ids` + `versions`) |
| `repo_hash` | Repository state for steps to include in inputs |
| `signal` | `AbortSignal` for cooperative cancellation on timeout/retry (optional) |

**Why `getInputs()`:** Steps own their input computation. Enables testing input canonicalization without running LLMs.

**Step cancellation contract:** The executor provides `ctx.signal` (`AbortSignal`) for cooperative cancellation. On timeout or before retry, the signal is aborted. Steps SHOULD check `ctx.signal?.aborted` periodically and exit early when true. Steps that ignore the signal will continue running in the background (the executor moves on without waiting).

**Step idempotency contract:** Multiple executions of `run()` may overlap if a step ignores the abort signal. Steps must be designed to handle this:
- Artifact writes use optimistic locking (`expected_version`) — concurrent writes fail safely
- External side effects should be idempotent or use deduplication keys

**Canonical implementation:** `src/engine/types.ts` — `Step`, `StepContext`, `StepInputs`, `StepOutput`, `RunConfig`, `ArtifactInputRef`, `StepVersioning`

**Domain types:** `src/schemas/run-record.ts` (`StepRecord`, `RunRecord`) and `src/schemas/step-result.ts` (`StepRunnerResult`, `PersistedStepResult`)

**Engine responsibilities:**
- Resolve `deps` → topological sort, parallel when independent
- Concurrency limit via semaphore (default: 4)
- `Promise.allSettled` for parallel batches
- Enforce `timeout` per step
- Handle retries with backoff up to `maxRetries`
- Persist `StepRecord` at RUNNING and terminal states
- Check idempotency via `step_instance_id` before running

**Why first-class:** Unit test orchestration without running models. Mock `step.run()`, verify engine handles deps/retries/timeouts correctly.

### Step Execution Protocol

Ordering for crash consistency:

1. Record step RUNNING → **persist RunRecord**
2. Run subagent
3. Write output artifacts to store
4. Write step-result artifact (`kind: "step-result"`, name: `{run_id}-{step_instance_id}`)
5. Record step OK/BLOCKED/FAILED → **persist RunRecord**

**Note:** Step-results are run-scoped (`{run_id}-{step_instance_id}`) to isolate crash recovery per-run. This prevents cross-run interference where different runs could overwrite each other's step-results.

**Crash recovery:** If crash between (4) and (5), on resume:
- Step shows RUNNING in RunRecord
- But step-result artifact exists with status + artifact_ids + actions
- Engine finalizes RunRecord from step-result → no rerun

This makes crash recovery provably correct: step-result artifact is atomic proof of completion.

**RunWriter idempotency:** RunWriter methods are idempotent for resume scenarios:
- `recordStepStarted()`: No-op if `step_instance_id` already exists (prevents duplicate RUNNING records)
- `recordStepSkipped()`: No-op if terminal record already exists (prevents duplicates for completed steps)
- `recordStepCompleted()`: Prefers RUNNING record, throws `STEP_NOT_FOUND` if no match
- `recordStepRecovered()`: Throws `STEP_NOT_FOUND` if step_instance_id not found (invariant violation)

This ensures resume never creates duplicate or orphan StepRecords, even when re-running steps that were RUNNING at crash time.

**Definition mismatch on resume:** If a RUNNING StepRecord references a step_id not in the current step definitions, recovery:
1. Finalizes the run as `BLOCKED` with error `STEP_DEFINITION_MISMATCH`
2. Creates a DLQ entry with partial results (completed steps' artifacts)
3. Throws `STEP_DEFINITION_MISMATCH` to the caller

Additionally, all RUNNING StepRecords are converted to `BLOCKED` with `error_code: STEP_DEFINITION_MISMATCH` so finalized runs do not contain orphan RUNNING steps.

**Invariant enforced:** `finalize()` throws `INVARIANT_VIOLATION` if any RUNNING steps remain. Callers must use `blockRunningSteps()` before `finalize()` when steps may be orphaned (e.g., definition mismatch, unrecoverable errors).

This prevents orphan RUNNING runs and provides structured recovery path. Causes: workflow definition changed between crash and resume, or wrong workflow invoked for resume.

**SQLite atomicity:** Step-result artifact + RunRecord event append should be a single SQLite transaction (`BEGIN IMMEDIATE`) when possible. RunWriter serializes writes through one connection. Crash recovery logic handles edge cases where transaction isn't achievable.

**Fan-out writes:** Multiple explorers finishing concurrently will race to persist. Serialize RunRecord writes through a single in-process RunWriter queue. Steps finish in any order; persistence is serialized. Steps publish events to RunWriter; only RunWriter mutates the RunRecord.

**Repo hashing (v1):**
- Git repo: `git rev-parse HEAD` + dirty flag
- Non-git: literal `"non-git"` + timestamp
- Audit metadata, not correctness-critical

**Inputs canonicalization:** `inputs_digest` must be deterministic and change if any upstream output changes. Before hashing:
- Include `repo_hash` for steps that read from the repo (ensures idempotency keys reflect repo state; prerequisite for any future cross-run caching)
- Include artifact `version` in refs, not just name/id (detects upstream changes even if name unchanged)
- Sort artifact refs by `(workspace, name ?? id)`
- Sort file lists alphabetically
- Normalize paths (forward slashes, no trailing slash)
- Deterministic JSON serialization with sorted keys (recursive)

**Canonical implementation:** `src/engine/idempotency.ts` — `computeStepInstanceId`, `computeInputsDigest`, `canonicalizeInputs`, `normalizePath`, `stableStringify`

### Run Record

Single source of truth for workflow execution. Scripts → platform.

**v1 invariant:** A run is owned by a single Finn process. Concurrent ownership is unsupported. On RunRecord update, check `owner_id` matches → fail fast on mismatch with error: "Run owned by another process."

**RunRecord fields:**

| Field | Purpose |
|-------|---------|
| `run_id` | Unique run identifier |
| `owner_id` | Process ownership (UUID generated on Finn startup) |
| `status` | RUNNING, OK, BLOCKED, FAILED |
| `workflow` | plan, feat, fix |
| `args` | Workflow arguments |
| `repo_hash` | Starting repo identity (git commit or tree hash) |
| `config` | Snapshot: rounds, retries, timeout_ms |
| `steps` | StepRecord array, ordered by step_seq |
| `created_at` / `updated_at` | ISO timestamps |
| `last_error` | ErrorCode if failed |
| `resume_from` | step_id for resume |

**StepRecord fields:**

| Field | Purpose |
|-------|---------|
| `step_id` | Step definition identifier |
| `step_instance_id` | Idempotency key (hash of inputs + versioning) |
| `step_seq` | Monotonic order for appends |
| `inputs_digest` | Hash of canonicalized inputs |
| `events` | Append-only event log (source of truth) |
| `artifact_ids` | Artifacts created by this step |
| `retry_count` / `repair_count` | Counters (derived from events) |
| `trace` | Model, prompt_version, artifact_ids_read |

**Event types:** STARTED, RETRY (with error + repair_attempt flag), OK, BLOCKED, FAILED, SKIPPED (idempotency hit), RECOVERED (crash recovery)

**Status values:** PENDING, RUNNING, OK, RETRYING, BLOCKED, FAILED

**Zod repair:** If output fails validation, attempt one repair call. If repair succeeds → increment `repair_count`. If repair fails → RETRY event with `SCHEMA_INVALID` error.

**Canonical implementation:** `src/schemas/run-record.ts` — `RunRecordSchema`, `ErrorCodeSchema`, `StatusSchema`

**Step Result Types:**

| Type | Status | Fields | Purpose |
|------|--------|--------|---------|
| `StepRunnerResult` | OK | `artifact_ids`, `actions?` | Runner succeeded |
| | RETRY | `error` | Retry with backoff (not persisted) |
| | BLOCKED | `artifact_ids`, `actions?`, `error`, `note?` | Needs human intervention |
| | FAILED | `artifact_ids`, `actions?`, `error`, `note?` | Unrecoverable failure |
| `PersistedStepResult` | OK | `artifact_ids`, `actions?` | Terminal: success |
| | BLOCKED | `artifact_ids`, `actions?`, `error`, `note?` | Terminal: blocked |
| | FAILED | `artifact_ids`, `actions?`, `error`, `note?` | Terminal: failed |

RETRY is internal to the engine loop — only terminal states are persisted as `kind:"step-result"` artifacts.

**Canonical implementation:** `src/schemas/step-result.ts` — `StepRunnerResultSchema`, `PersistedStepResultSchema`

**Event sourcing:** `events` is the source of truth. `status`, `retry_count`, and `repair_count` are derived on load by folding events via `applyEventFold()`. Denormalized fields are still written for debugging, but overwritten on every load. `error_code` is excluded from the fold (events don't carry it; write-only). Drift between stored and derived values is logged via `console.debug`.

**Canonical implementation:** `src/engine/event-fold.ts` — `foldEvents()`, `applyEventFold()`. Applied in `RunWriter.init()` (resume) and `persistWithRetry()` (VERSION_MISMATCH reload).

**Enables:**
- DLQ with resume point
- Replay from specific step
- Tripwire tracking (retries, thrashing)
- Audit trail

**Persisted via ArtifactStore:**

RunRecords are stored as artifacts in `workspace: "runs"` with TTL based on outcome:
- Success (OK): 7 days
- Failure (BLOCKED/FAILED): 30 days

Use `storeArtifact()` wrapper which enforces TTL policy. Updates use optimistic locking via `expected_version`.

**Canonical implementation:** `src/policies/ttl.ts` — `storeArtifact`, `getRunRecordTtl`

**Optimistic concurrency:** `expected_version` implies update — store rejects if version doesn't match or artifact not found. No race window between read and write.

**VERSION_MISMATCH handling:** On conflict, reload and single retry. After reload, re-validate invariants:
- `owner_id` matches → throw `RUN_OWNED_BY_OTHER` if taken by another process
- `status === "RUNNING"` → throw `RUN_ALREADY_COMPLETE` if finalized

If retry also fails, throw error. Conflicts are unexpected (RunWriter queue serializes in-process writes). Repeated conflicts indicate concurrent processes or bug — investigate, don't silently loop.

### Idempotency

One rule for step-level idempotency:

```
step_instance_id = hash(step_id + inputs_digest + model + schema_version + prompt_version)
```

| Field | Source |
|-------|--------|
| `step_id` | Step definition |
| `inputs_digest` | Hash of step inputs + artifact refs from deps |
| `model` | Model used (e.g., "sonnet", "haiku") |
| `schema_version` | Output schema version |
| `prompt_version` | Prompt template version |

**Behavior:** Before running any step, check if step-result artifact exists for `{run_id}-{step_instance_id}` → skip.

**Scope:** Step-results are run-scoped for crash recovery within the same run. Cross-run caching is not supported in v1 because LLM outputs are non-deterministic (same inputs ≠ same outputs) and artifact_ids are ULIDs (not content-addressed).

**Enables:**
- Resume after crash (same run, same inputs → skip completed step)
- Model change forces re-run (different model → new instance_id)
- Schema change forces re-run (different schema_version → new instance_id)
- Prompt change forces re-run (different prompt_version → new instance_id)

**Side effect idempotency:**

| Side Effect | Strategy |
|-------------|----------|
| File edits | Pre/post hash rule (see below) |
| Artifact writes | Check existing by name before store |
| External calls | Track in step actions |

**File edit rule:** Record `pre_hash` (file contents before edit) and `post_hash` (after edit) in StepAction. On resume:
- Current hash = `post_hash` → skip (already applied)
- Current hash = `pre_hash` → apply edit
- Current hash ≠ both → `HUMAN_REQUIRED` (file modified externally)

**Hashing specification:**
- Algorithm: SHA-256 on raw bytes (no newline normalization)
- Paths: canonicalized before hashing (forward slashes, no trailing slash)
- Rationale: Raw bytes avoids platform-specific newline issues; canonical paths ensure cross-platform consistency

### Action Tracking

Per-step action log for audit trail and resume correctness.

**StepAction fields:**

| Field | Purpose |
|-------|---------|
| `action_id` | Idempotency key: `hash(step_id + op + path + inputs)` |
| `path` | Canonicalized file path (forward slashes, no trailing slash) |
| `op` | edit, create, delete, external |
| `pre_hash` | For edits: SHA-256 of raw file bytes before |
| `post_hash` | For edits: SHA-256 of raw file bytes after |
| `external_ref` | For external: ticket id, API response id, etc. |

**Why action_id:** Enables idempotent replay. On resume, check if action already applied by comparing hashes.

**Why external_ref:** External calls (create ticket, send email) can't be undone. Store the reference for audit and to detect "already done."

**Canonical implementation:** `src/schemas/run-record.ts` — `StepActionSchema`

### DLQ + Resume

When a workflow fails after retries exhausted, store failure state for later resumption.

**DLQ Entry:** Stored as artifact (`kind: "dlq-entry"`) in `workspace: "dlq"` (persistent, no TTL):
- `data`: `workflow`, `task`, `failed_step`, `inputs`, `retry_count`, `last_error`, `relevant_files`, `partial_results`, `summary`
- `run_id`: from artifact metadata (not duplicated in data)
- `failed_at`: use artifact's `created_at`

**Canonical implementation:** `src/schemas/dlq-entry.ts` — `DlqEntrySchema`

**DLQ triggers (automatic):**
- Step fails/blocks after retries exhausted → DLQ entry with `retry_count`, `last_error`, `partial_results`
- `STEP_DEFINITION_MISMATCH` on resume → DLQ entry with blocked step info

DLQ writes use `mode: "replace"` for idempotency (safe to retry after crash).

**Resume flow:**
1. `finn resume <run_id>` fetches DLQ entry
2. Read `data.workflow`, `data.failed_step` (typed, no parsing)
3. Route to workflow with `resume_from: failed_step`

**Retention policy:**

| Outcome | Run Record TTL | Ephemeral Artifacts |
|---------|----------------|---------------------|
| **Success** | 7 days | Auto-expire via TTL policy |
| **Failure/BLOCKED** | 30 days | Kept for debugging/resume |

**Design:**
- No LLM judgment — human already decided to retry
- DLQ entry has everything needed to resume
- Deterministic routing based on `workflow` field

---

## Workflows Overview

| Workflow | Pattern | Design Doc |
|----------|---------|------------|
| **Plan** | Fan-out explorers → fan-in → stitch | [plan.md](plan.md) |
| **Feat** | Design → impl → verify loops | [feat.md](feat.md) |
| **Fix** | Grouping + parallel/sequential execution | [fix.md](fix.md) |

---

## Subagents Overview

All subagents live at Finn level (`finn/src/subagents/`), making Finn self-contained.

| Category | Subagents | Used By |
|----------|-----------|---------|
| **Explorers** | code, test, doc, migration | Plan |
| **Verifiers** | design-verifier, impl-verifier | Feat, Fix |
| **Synthesizers** | stitcher | Plan |

---

## Artifact Usage

See [artifacts.md](artifacts.md) for full spec (interface, types, storage implementation).

This section covers how **workflows use artifacts** — TTL policies, naming conventions, and workflow-specific patterns.

### TTL Policy

The artifact store provides the mechanism (`ttl_seconds` on store). Finn owns the policy — what TTL to use for each artifact type.

**TTL Constants:**

| Name | Value | Usage |
|------|-------|-------|
| EPHEMERAL | 1 hour | Explorer findings |
| SESSION | 2 hours | Verifier outputs, design specs |
| RUN_SUCCESS | 7 days | Successful run records |
| RUN_FAILURE | 30 days | Failed/blocked run records |
| PERSISTENT | no expiry | DLQ entries |

**Workspace Defaults:**

| Workspace | TTL | Purpose |
|-----------|-----|---------|
| `plan` | 1 hour | Explorer findings |
| `feat` | 2 hours | Verifier outputs, design specs |
| `fix` | 2 hours | Fix session state |
| `runs` | 7d / 30d | Run Records, step-results (success / failure) |
| `dlq` | persistent | DLQ entries for resume |

**`storeArtifact()` wrapper rules:**
- `ttl_seconds: undefined` → use workspace default
- `ttl_seconds: null` → explicit no expiry (pass through)
- `ttl_seconds: number` → use as-is
- `run-record` and `step-result` require positive finite `ttl_seconds` (use `getRunRecordTtl()`) — permanent runs not allowed

### Size Limits

The artifact store has a ceiling (200K chars for data, 12K for text). Finn enforces kind-specific limits before storing.

| Kind | Data Limit | Rationale |
|------|------------|-----------|
| `run-record` | 200K | Grows unboundedly (steps × events) |
| All others | 50K | Bounded per-step output |

### Artifact Per Workflow

| Kind | Workspace | Name Pattern | TTL |
|------|-----------|--------------|-----|
| `explorer-finding` | `plan` | `{run_id}-{role}` | 1 hour |
| `verifier-output` | `feat` | `{run_id}-{role}-r{N}` | 2 hours |
| `design-spec` | `feat` | `{run_id}-design` | 2 hours |
| `run-record` | `runs` | `{run_id}` | 7d / 30d |
| `step-result` | `runs` | `{run_id}-{step_instance_id}` | Aligned to run at finalize |
| `dlq-entry` | `dlq` | `{run_id}` | persistent |

**Naming conventions:**
- Round suffix `-r{N}` when role runs multiple times (e.g., `verifier-r1`, `verifier-r2`)
- Step-result keyed by `{run_id}-{step_instance_id}` for run-isolated crash recovery

**Step-result TTL alignment:** Step-results are stored with conservative 30-day TTL during execution (for crash recovery). At run finalization, TTLs are aligned to match the run's final status:
- **OK run** → step-results downgraded to 7 days
- **BLOCKED/FAILED run** → step-results remain at 30 days (no change needed)

This ensures step-results never expire before the run-record they belong to.

### Phase Tracking

```
plan: exploring → stitching → complete
feat: design → implementing → verifying → complete
fix:  planning → executing → complete
```

### Run ID Scoping

Scope parallel work with `run_id`:

```typescript
run_id: "{workflow}-{slug}-{timestamp}"

// Fan-out: subagents store with run_id (TTL via storeArtifact wrapper)
await storeArtifact({ workspace: "plan", run_id, role: "code-explorer", kind: "explorer-finding", data, ... });

// Fan-in: gather all findings (returns data, not just metadata)
const findings = await store.list({ run_id, kind: "explorer-finding" });

// Cleanup: ephemeral findings auto-expire via TTL (1 hour for plan workspace)
```

### Deterministic Fan-in

Fan-out → fan-in is where subtle nondeterminism sneaks in. Two rules:

**1. Stable ordering:** Sort findings deterministically before stitching.
```typescript
const relevanceRank = { high: 3, medium: 2, low: 1 };
const sorted = findings.sort((a, b) =>
  a.role.localeCompare(b.role) ||
  a.path.localeCompare(b.path) ||
  relevanceRank[b.relevance] - relevanceRank[a.relevance]
);
```

**2. Dedupe overlapping files:** Merge when multiple explorers find the same file.
```typescript
const deduped = mergeByPath(sorted, (a, b) => ({
  ...a,
  summaries: [...(a.summaries || [a.summary]), b.summary].slice(0, 3), // cap to prevent blowup
  relevance: higherRelevance(a.relevance, b.relevance),
}));
```

This makes stitcher inputs consistent and improves replay correctness.

### Structured Explorer Output

Explorers output JSON (validated by Zod), stored as artifacts:

```typescript
// Explorer returns structured JSON
const output: ExplorerOutput = {
  files: [
    { path: "src/auth.ts", relevance: "high", summary: "Add JWT validation" },
    { path: "src/middleware.ts", relevance: "high", summary: "Add auth check" },
  ],
  patterns: ["middleware chain", "token validation"],
  concerns: ["Token expiry duration unclear"],
  confidence: 0.85,
};

// Finn validates with Zod, stores as artifact (TTL via wrapper)
await storeArtifact({
  workspace: "plan",
  name: `${run_id}-code-explorer`,
  kind: "explorer-finding",
  data: output,
  text: renderExplorerFinding(output),  // rendered view for LLM consumption
  run_id,
  role: "code-explorer",
});  // → ttl_seconds: 3600 (1 hour, from WORKSPACE_TTL)
```

This ensures:
- Machine-checkable validation (Zod schema)
- Repair retries on malformed output
- Code can operate on `data` (sort, filter, dedupe)
- LLMs consume rendered `text` via `artifact_compose`

### Text Rendering

Finn renders `text` from `data` before storing. Each artifact kind has a dedicated renderer that produces structured markdown for LLM consumption.

**Invariant:** Renderers are pure functions `(data: T) → string`. They omit empty sections and group content for efficient LLM parsing.

**Implementation:** `src/renderers/` — `renderExplorerFinding` (others added as needed)

### Subagent Memory

Verifiers store artifacts per round, enabling cross-round comparison:

```typescript
// Round 1: store verifier output (TTL via wrapper)
await storeArtifact({
  workspace: "feat",
  name: `${run_id}-verifier-r1`,
  kind: "verifier-output",
  data: { verdict: "concerns", issues: [...] },
  run_id,
  role: "impl-verifier",
});  // → ttl_seconds: 7200 (2 hours)

// Round 2: fetch previous, compare issues
const prev = await store.fetch({ workspace: "feat", name: `${run_id}-verifier-r1` });
const resolved = prev.data.issues.filter(i => !currentIssues.has(i.id));
```

### Token Optimization

> **v1 note:** Optimization logic deferred until /plan works end-to-end.

`list()` returns `data` by default, enabling code to operate without full fetch:

```typescript
// List returns structured data — code can sort/filter/dedupe
const findings = await store.list({ run_id, kind: "explorer-finding" });
const highPriority = findings.items.filter(f => f.data.confidence > 0.8);

// Only fetch full text when needed for LLM consumption
const bundle = await store.compose({
  items: highPriority.map(f => ({ id: f.id })),
});
```

### Compose (Bundle Artifacts)

Bundle artifact text views into single context for LLM consumption:

```typescript
const bundle = await store.compose({
  items: [
    { workspace: "plan", name: `${run_id}-code-explorer` },
    { workspace: "plan", name: `${run_id}-test-explorer` },
    { workspace: "plan", name: `${run_id}-doc-explorer` }
  ]
});
// → bundle.bundle_text: single markdown document for stitcher
```

---

## What This Achieves

| Aspect | Before (prompt) | After (Finn) |
|--------|-----------------|--------------|
| Loop control | "max 2 rounds" | `for (round <= 2)` enforced |
| Parallelism | "spawn in parallel" | Deterministic fan-out/fan-in |
| Fan-out/fan-in | Describe pattern | Enforced coordination via `run_id` scoping |
| Coverage | 70-80%, misses docs | 100% via dedicated explorers |
| State updates | Hope it happens | `storeArtifact` with TTL policy |
| Timeout | None | `withTimeout()` wrapper |
| Testing | None | Unit tests for grouping, explorers |
| Debugging | Read output after | Logs, breakpoints, stack traces |

---

## Claude Code Integration

Add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "finn": {
      "command": "node",
      "args": ["/path/to/finn/dist/index.js"]
    }
  }
}
```

User experience:
```
> /plan "add user authentication"
→ finn__plan runs fan-out/fan-in
→ Returns comprehensive plan file

> /feat dev/plans/add-auth.md
→ finn__feat runs design → impl → verify
→ Returns implementation result

> /fix "SQL injection in queries.go:45"
→ finn__fix groups and executes
→ Returns fix summary
```

---

## Project Structure

```
finn/
├── src/
│   ├── index.ts              # MCP server entry
│   ├── server.ts             # Tool definitions
│   ├── engine/               # Step execution harness
│   │   ├── index.ts          # Public exports
│   │   ├── types.ts          # Step, StepContext, StepInputs, RunConfig
│   │   ├── errors.ts         # ExecutorError (graph validation errors)
│   │   ├── executor.ts       # Topo-sort, parallel batches, Promise.allSettled
│   │   ├── run-writer.ts     # Serialized RunRecord writes
│   │   ├── event-fold.ts     # Derive status/retry/repair from events
│   │   ├── semaphore.ts      # Counting semaphore for concurrency
│   │   ├── batch.ts          # Group steps by dependency level
│   │   └── idempotency.ts    # step_instance_id computation
│   ├── workflows/
│   │   ├── plan.ts           # Plan: fan-out/fan-in/stitch
│   │   ├── feat.ts           # Feat: design/impl/verify loops
│   │   └── fix.ts            # Fix: grouping + parallel/sequential
│   ├── subagents/
│   │   ├── explorers/
│   │   │   ├── code.ts
│   │   │   ├── test.ts
│   │   │   ├── doc.ts
│   │   │   └── migration.ts
│   │   ├── verifiers/
│   │   │   ├── design.ts
│   │   │   └── impl.ts
│   │   └── stitcher.ts
│   ├── grouping/
│   │   └── fix-grouper.ts    # Overlap analysis
│   ├── artifacts/            # Storage layer (see artifacts.md)
│   │   ├── index.ts          # Public exports
│   │   ├── types.ts          # Artifact, StoreOpts, etc.
│   │   ├── errors.ts         # ArtifactError, ErrorCode
│   │   ├── store.ts          # ArtifactStore interface
│   │   ├── normalize.ts      # Name/workspace normalization
│   │   └── sqlite.ts         # SqliteArtifactStore
│   ├── schemas/              # Zod schemas per artifact kind
│   │   ├── index.ts          # Public exports
│   │   ├── dlq-entry.ts      # DLQ entry for failed/blocked runs
│   │   ├── explorer-finding.ts
│   │   ├── run-record.ts     # + ErrorCode, Status, StepAction, StepEvent, StepRecord
│   │   └── step-result.ts    # Crash recovery artifact
│   ├── policies/
│   │   ├── index.ts          # Public exports
│   │   └── ttl.ts            # TTL constants, storeArtifact() wrapper
│   ├── renderers/            # Text renderers (data → markdown)
│   │   ├── index.ts          # Public exports
│   │   └── explorer-finding.ts
│   └── moss/
│       └── client.ts         # Moss MCP client (Capsule export)
├── package.json
└── tsconfig.json
```
