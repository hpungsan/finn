# Finn Backlog

Features and enhancements for future versions.

---

## v1 Backlog

Enhancements to the code-based orchestration layer. No new LLM components.

---

### Core Runtime

#### Deterministic Audit View

RunRecord `step_seq` is append order — parallel steps can finish in different orders across runs. This is fine for correctness (idempotency is by hash, not position), but makes cross-run comparison harder for auditing.

**Add:** `renderAuditView(record: RunRecord)` that sorts steps deterministically (by `step_id`, then by first event timestamp) for comparison.

**When to add:** If audit/comparison tooling becomes important. Not blocking for v1.

---

#### Renderer Registry

Currently workflows import renderers directly (`renderExplorerFinding`). Add a registry for dynamic dispatch by artifact kind when multiple renderers exist.

```typescript
const RENDERERS: Record<ArtifactKind, (data: unknown) => string> = {
  "explorer-finding": renderExplorerFinding,
  "verifier-output": renderVerifierOutput,
  // ...
};

function renderArtifact(kind: string, data: unknown): string {
  const renderer = RENDERERS[kind];
  if (!renderer) throw new Error(`No renderer for kind: ${kind}`);
  return renderer(data);
}
```

**When to add:** Once 3+ renderers exist. Not needed with just `explorer-finding`.

---

#### Cross-Run Caching

Skip step execution when inputs match a previous run. Separate from crash recovery (per-run step-result).

**Status:** Deferred for v1 — step-results are run-scoped for crash recovery, and naive cross-run caching is incorrect for LLM steps + ULID artifact pointers.

**Design (if implemented):**
- New artifact kind: `step-cache` (global, keyed by `step_instance_id`)
- On cache hit: materialize artifacts into current run (copy with new ULIDs, run-scoped names)
- Write per-run step-result pointing to this run's artifact IDs
- Per-step `cache_policy`: `"never"` (default for LLM) | `"deterministic"` | `"allow"`
- Concurrency-safe writes: `mode: "error"` on cache population (no clobber)

**When to add:** After /plan works end-to-end, if cost savings justify complexity. Only correct for pure/deterministic steps.

---

#### Per-Tool Rate Limits

Base has semaphore concurrency for steps. Add per-tool rate limits for commands/search that may have stricter API limits.

#### Configurable Timeouts

Per-agent timeout settings via config or flags.

#### Extended Trace Fields

Richer tracing for replay and debugging. Deferred from base to ship lean.

**Add to StepRecord.trace:**
- `repo_tree_hash_before/after` — per-step repo snapshots
- `tool_calls` — `{ name, args_hash }[]`
- `config_hash`, `rendered_prompt_hash`
- `input_artifact_hashes` — artifact + key file hashes

#### Action Ledger

Full conflict detection (runtime). Base has `StepAction` with `action_id`, `pre_hash`, `post_hash`, `external_ref`. Action Ledger adds cross-step conflict detection and override tracking.

```typescript
interface ActionLedger {
  run_id: string;
  actions: Action[];
  allow_conflicts: boolean;  // --allow-conflicts flag
}

interface Action {
  action_id: string;  // "{step_id}:{idx}" or uuid
  type: "edit_file" | "create_file" | "delete_file" | "external_call";
  path: string;
  idempotency_key: string;
  patch_hash: string;
  step_id: string;
  supersedes_action_id?: string;
  superseded_by_action_id?: string;
}

// Before applying an action
function applyAction(ledger: ActionLedger, action: Action): boolean {
  const existing = ledger.actions.find(a => a.idempotency_key === action.idempotency_key);
  if (existing) {
    if (existing.patch_hash === action.patch_hash) return false; // skip, already done

    // Conflict: same target, different patch
    if (!ledger.allow_conflicts) {
      throw new ConflictError(existing, action);
    }

    // Override allowed: must be new step + record supersession
    if (action.step_id === existing.step_id) {
      throw new ConflictError(existing, action); // same step can't override itself
    }

    action.supersedes_action_id = existing.action_id;
    existing.superseded_by_action_id = action.action_id;
  }

  ledger.actions.push(action);
  return true; // proceed
}
```

**Idempotency Key Schemes:**

Line ranges drift as edits happen, making `{path}:{line_range}` fragile. Use stable identifiers:

| Scheme | When to use | Example |
|--------|-------------|---------|
| `{path}:{function_name}` | Function/method edits (preferred) | `src/auth.ts:validateToken` |
| `{path}:{class_name}` | Class-level changes | `src/user.ts:UserService` |
| `{path}:{preimage_hash}` | Fallback when no symbol detected | `src/config.ts:a1b2c3d4` |

```typescript
function computeIdempotencyKey(path: string, content: string, range: CharRange): string {
  // Try symbol detection first, fallback to preimage hash
  const symbol = detectEnclosingSymbol(content, range);
  if (symbol) return `${path}:${symbol.type}:${symbol.name}`;

  const preimage = content.slice(range.start, range.end);
  return `${path}:${hashPrefix(preimage, 8)}`;
}
```

**Enables:** Conflict detection, audit trail, safe resume from partial runs, deterministic override with `--allow-conflicts`.

#### DLQ Extensions

Extends base DLQ (see FINN.md) with export and retention controls.

**Export for handoff:**
```bash
finn export-dlq <run_id>  # generates capsule for human review / cross-session handoff
```

**Retention flags:**
- `--keep-artifacts` — skip ephemeral workspace cleanup on success

**Partial results:** `dlq-entry.data.partial_results` (already in base schema) — artifacts completed before failure, enabling smarter resume (skip completed work). Backlog: implement resume logic that uses this field.

---

### Safety Rails

#### Orchestration Tripwires

Deterministic triggers that extend v1 hardening:

| Trigger | Action |
|---------|--------|
| 2+ retries fail | Mark run `needs_human`, reduce scope |
| Tool output > N tokens | Mask + store full output as artifact |
| Same file edited > K times | Escalate to re-plan |

These are code policies, not LLM judgment.

#### Budget Tracking

Max parallel solves rate limits but not token/cost blowups. Track and enforce budgets at the run level.

**RunRecord Extension:**

```typescript
budget: {
  token_limit?: number;       // e.g., 50000
  token_spent: number;        // running total from API responses
  cost_limit_usd?: number;
  cost_spent_usd: number;
  exceeded: boolean;
  exceeded_at_step?: string;
}
```

**Behavior:**
- Check budget before each step/subagent spawn
- Current step completes if limit hit mid-call (don't interrupt)
- No new steps spawn after exceeded
- Run status → `BLOCKED` with `reason: "budget_exceeded"`

**CLI:**
```bash
finn feat plan.md --token-budget=50000
finn feat plan.md --cost-budget=1.00
```

---

### Quality + Tooling

#### Diminishing Returns Detection

Stop loops when no progress is being made. Requires structured verifier output for deterministic comparison.

**Verifier Issue Schema:**

```typescript
interface VerifierIssue {
  id: string;              // stable: "{file}:{category}:{message_hash}"
  file: string;
  line?: number;           // optional, excluded from comparison (drifts)
  category: IssueCategory; // type_error | logic_error | test_failure | ...
  message: string;
  severity: "error" | "warning" | "info";
}
```

**Comparison:** Normalize issues (sort by file/category/severity, hash messages, exclude line numbers), then compare hashes across rounds.

| Signal | Detection | Action |
|--------|-----------|--------|
| Same issues recurring | Hash match | BLOCKED |
| Issue count plateau + same files | `r2.length >= r1.length` | BLOCKED |
| Partial progress | `r2.length < r1.length` | Continue |

#### Replay CLI

CLI tooling for debugging and manual resume:

```bash
finn replay --run_id X              # replay full run
finn replay --run_id X --from step3 # resume from step
finn replay --run_id X --dry-run    # check invariants only
```

Basic replay for debugging. Eval/optimization replay is v2 (Eval Harness).

#### Run Inspector

Read-only view of run state for debugging and demos:

```bash
finn run show <run_id>
```

**Output:**
- Status (RUNNING / OK / BLOCKED / FAILED)
- Current/last step
- Per-step retry counts
- Links to artifacts (run record, step results, DLQ entry if failed)
- Timestamps (started, updated, duration)

**Why:** Low effort, high value for day-to-day development and clean demos. Pure read over Run Record — trivial once storage exists.

#### Run Invariant Checker

Lightweight validation command — proves correctness without LLM eval infrastructure.

```bash
finn check --run <run_id>
```

**Checks:**
- No step exceeded `maxRetries`
- Schema validated at every gate (all outputs match `schema_version`)
- Deterministic ordering stable (sorted input digest matches)
- No duplicate `action_id`s
- All `artifact_ids` exist in store

**Output:** Pass/fail with violations listed. Foundation for v2 Eval Harness.

#### Progress Notifications

Stream progress updates via MCP notifications.

#### Runner Version in step_instance_id

Add `runner_version` (Finn git SHA or package.json version) to `step_instance_id` hash. Forces cache invalidation when orchestration semantics change, even if prompt/schema unchanged.

```
step_instance_id = hash(step_id, inputs_digest, schema_version, prompt_version, runner_version)
```

#### Store Diffs in StepAction

Add optional `diff` field to `StepAction` for auditability and replay.

```typescript
interface StepAction {
  // ... existing fields
  diff?: string;  // unified diff for file edits
}
```

**Trade-off:** Storage vs auditability. Store diff only for edits under size threshold (e.g., <10KB diff). Large diffs get hash-only.

**Enables:** Audit trail, optional replay, "human required" debugging.

---

## v2 Backlog

Finn remains a deterministic orchestration runtime. v2 adds optional meta-reasoning, durable knowledge storage, and closed-loop optimization — implemented as separate components that consume Finn traces and update the inputs Finn uses (prompts, policies, knowledge).

---

### Multi-Process Run Ownership

v1 invariant: a run is owned by a single Finn process (`owner_id` check). v2 could lift this with distributed locking or leader election for scenarios like horizontally-scaled workers processing a shared run queue.

---

### Advanced DAG Scheduling

v1 uses static topological sort. v2 adds dynamic capabilities:

| Feature | Description |
|---------|-------------|
| Dynamic step insertion | Add steps mid-run based on findings |
| Speculative execution | Start steps before deps confirmed |
| Conditional branches | Route based on step outputs |
| Retry reordering | Try different step order on failure |

---

### Meta-Supervisor

LLM invoked **only on escalation**, not always-on. Handles meta-level workflow decisions when deterministic policy cannot safely choose.

**Triggers (deterministic):**
- Tripwire fires (retries ≥ 2, thrashing, conflicts)
- Deadline exceeded (token/time/budget cap)
- Conflicting subagent outputs / verifier disagreement
- Blocked state from diminishing returns heuristic

**Input:** Small, structured, pointer-heavy — run summary artifact ID, relevant artifact IDs, last error, constraints, workspace context refs.

**Output (constrained actions only):**

| Action | Description |
|--------|-------------|
| `RESCOPE(new_task)` | Reduce scope to minimal viable step |
| `REPLAN(new_outline)` | Different approach / ordering |
| `REQUEST_HUMAN(question)` | Ask user for missing constraint |
| `ABORT(reason)` | Stop safely with explanation |

**Design:** Enterprise reliable — deterministic triggers, constrained outputs, auditable provenance.

---

### Verifier Council

Multiple verifiers review independently, majority vote on verdict. Inspired by [LLM Council](https://github.com/karpathy/llm-council).

**Rationale:** Verifier verdicts drive the core loop. Wrong verdicts are expensive:
- False positive (finds issues that aren't) → unnecessary rounds, thrashing
- False negative (misses issues) → ships broken code

**How it works:**
1. Fan-out: 3 verifiers review independently (same input, different model instances or prompts)
2. Collect verdicts: PASS / CONCERNS / FAIL
3. Majority vote determines outcome
4. Disagreement (e.g., 1 PASS, 1 CONCERNS, 1 FAIL) → escalate to meta-supervisor or human

**When to enable:**
- High-stakes workflows (production deployments)
- Tasks with ambiguous correctness criteria
- When false negatives are costly

**Trade-off:** 3x verifier cost + latency. Opt-in for critical paths, not default.

**Extension:** Could also apply to meta-supervisor decisions (RESCOPE vs REPLAN vs ABORT) and eval harness judges.

---

### Run Finalizer

Post-processing step after each Finn workflow (plan/feat/fix). Compiles run artifacts into durable state.

#### Stage A — Deterministic (code, always-on)

Pure extraction, cheap and testable:
- `run_summary`: status, timestamps, IDs, workflow name, budgets
- `run_index`: files touched, errors encountered, artifact provenance
- `run_metrics`: rounds, retries, timeouts, token/cost stats
- Hygiene: masking, size limits, DLQ state
- Provenance: every artifact points back to source artifact IDs

#### Stage B — Curated Knowledge Extraction (LLM, optional)

Judgment-based distillation into lore:
- Playbooks ("if verifier fails with X, try Y")
- Pitfalls (gotchas tied to evidence)
- Repo map updates
- Resolves ambiguity when artifacts are messy

**When to run:**
- Successful runs (high-signal)
- DLQ/blocked runs (valuable failure summaries)
- Explicit flag (`--llm-finalize`)
- Not after every run by default

**Guardrails:**
- Output schema + max tokens
- Must include `sources: [artifact_ids]`
- Write to `lore` workspace only if confidence ≥ threshold
- If LLM fails → skip, do not break the run

---

### Lore (Long-Lived Knowledge)

Durable knowledge extracted from runs. Uses existing ArtifactStore with `workspace: "lore"` and `ttl_seconds: null` (persistent).

**No new store needed.** Same interface as other artifacts, just persistent.

**Lore types (artifact kinds):**
- `playbook` — if X happens, do Y (structured triggers + actions)
- `pitfall` — gotchas tied to evidence (file patterns + warnings)
- `repo-map` — stable layout + key entrypoints (structured paths)

**Schema:** Lore are typed JSON (Zod-validated), not free-form text. Code operates on `data`, LLMs consume rendered `text`.

```typescript
// Example playbook
{
  kind: "playbook",
  workspace: "lore",
  data: {
    trigger: { file_pattern: "src/auth/*", error_pattern: "token_*" },
    action: "Check token expiry validation",
    confidence: 0.85,
    hit_count: 12,
  },
  sources: ["artifact-xyz"],  // provenance
  ttl_seconds: null,  // persistent
}
```

**Retrieval (Step 0):** Before fan-out, query lore for relevant prior work:
- Filter by file patterns, error categories
- Inject matches into subagent context
- Ensures explorers leverage proven patterns and avoid past mistakes

**Write:** Finalizer extracts lore (gated by confidence + provenance required).

---

### Optimization Pipeline

External layer that improves prompts and policies using Finn traces. Finn emits traces; optimizer updates artifacts; Finn loads updated artifacts next run. **Consider:** Significant scope — evaluate LangSmith, Microsoft Agent Lightning, or similar before building custom.

**Reference:** [Microsoft Agent Lightning](https://github.com/microsoft/agent-lightning)

**Optimization targets:**
- Prompt variants (explorers, verifiers, stitcher, meta-supervisor)
- Routing thresholds (retry vs replan vs ask human)
- Stop policies (diminishing returns thresholds)
- Retrieval policies (which lore to fetch per stage)

**Learning signals:**
- Verifier pass/fail        ← LLM-based (risky)
- Retry counts              ← non-LLM ✓
- Time to completion        ← non-LLM ✓
- Human escalations         ← non-LLM ✓
- Blocked outcomes + reasons ← non-LLM ✓
- Tests pass/fail           ← non-LLM ✓ (preferred)
- Build passes              ← non-LLM ✓ (preferred)
- Lint clean                ← non-LLM ✓ (preferred)
- Human didn't revert       ← non-LLM ✓ (preferred)

**Ground truth warning:** Prefer non-LLM signals. LLM-based signals (verifier pass) can create feedback loops — "self-licking ice cream cone" if verifier and optimizer both use LLMs.

---

### Eval Harness

Validate prompt/policy changes before rollout. Builds on v1's basic replay. **Consider:** LangSmith already provides experiment tracking, prompt versioning, and eval comparison — evaluate before building custom.

**Workflow:**
1. Store traces from production runs (Run Records + artifacts)
2. Replay workflows with candidate prompts/policies
3. Compare success metrics across versions
4. Promote winners, roll back regressions

**Storage model:**

| Data | Storage | Why |
|------|---------|-----|
| Run Records | Artifacts (`kind: "run-record"`) | Structured state, `run_id`/`phase`/`role` |
| Golden marker | Tag on artifact | `tags: ["golden"]` |
| Subagent outputs | Artifacts (per-kind schemas) | Typed JSON + rendered text |
| Prompt variants | Artifacts (`workspace: "prompts"`) | Versioned via tags, persistent |
| Eval reports | Artifacts (`workspace: "eval"`) | Comparison results, persistent |

**Replay for eval** (vs v1 replay for debug):
- Swap prompts from `prompts` workspace during replay
- Golden runs = Run Record artifacts with `tags: ["golden"]`
- A/B comparison across prompt variants

This is the feedback loop that guarantees improvement, not just change.

---

### Learned Stop Policy

Train on run traces to predict when another round won't help. **Consider:** ML problem — research existing approaches before building custom.

**v1:** Heuristic (hash comparison, issue-count plateau)
**v2:** Learned thresholds per issue type ("auth tasks need 3 rounds", "refactors need 1")

**Actions:** Stop + summarize, rescope, replan, ask human.

**Key principle:** Learned policy is a *recommendation*, not authority. Code supervisor enforces hard caps; learned policy adjusts within safe bounds (suggests early stop, one extra round, or "ask human now"). Smart advisor, not smart ruler.

---

### Auto Mode (`--auto`)

Policy-driven loop control. `--auto` selects named policies, not magic behavior.

```bash
finn feat plan.md --auto
# Equivalent to:
finn feat plan.md --stop-policy=default --budget-policy=default
```

**Explainable:** "stop-policy-v3 stopped because plateau for 2 rounds"

**Why v2:** Requires policy infrastructure (versioned policies, learned stop policy). Without it, `--auto` is just hardcoded heuristics — v1 has the building blocks (diminishing returns heuristic, budget tracking), v2 composes them into selectable policies.

---

### Cross-Project Knowledge

Optional. Share patterns across codebases via global lore workspace.

**Requirements:**
- Strict namespacing
- Confidence + provenance required
- Opt-in per project (default off)

---

### Implementation Order

Safe sequencing — each step requires the previous:

1. **Collect traces + outcomes** → Run Record (v1) — foundation for everything
2. **Replay/eval harness** → Eval Harness — can't safely change what you can't measure
3. **Optimize thresholds first** → Routing thresholds (low risk, easy to validate)
4. **Learned stop policy** → Advisor mode (medium risk, bounded by hard caps)
5. **Prompt optimization** → High risk, requires good evals to avoid regressions

Don't skip to step 5 without step 2. "Optimizing prompts with no measurement" is a common trap.

---

### Policies as Configuration

Runtime loads versioned policy artifacts:
- `stop-policy-v17`
- `routing-policy-v12`
- `prompt-set-v8`

Debugging becomes: "Why did we stop?" → `stop-policy-v17` recommended stop + hard cap reached.

Policies are versioned, evaluated, promoted, rolled back — like code deploys.

---

### Stack Positioning

```
Optimization Pipeline ──→ updates prompts/policies (external)
         ↑ traces
       Finn ──────────────→ deterministic orchestration + trace emission
         │
         ├── Workflows ────→ plan, feat, fix (control flow)
         │
         ├── Subagents ────→ explorers, verifiers, stitcher (LLM reasoning)
         │        │
         │        ↓ retrieve
         │    Lore ───→ playbooks, pitfalls, repo-maps (persistent artifacts)
         │
         ├── Artifact Store → ALL internal state (ephemeral + persistent)
         │        │
         │        ├── runs, plan, feat, dlq (TTL-based)
         │        ├── lore (persistent)
         │        └── prompts, eval (persistent)
         │
         ├── Finalizer ────→ Stage A (code) + Stage B (LLM, optional)
         │        │
         │        └───────→ writes to lore workspace
         │
         └── Meta-supervisor → escalation-only LLM (v2)

External (optional):
       Moss ──────────────→ Capsules for session handoffs (export on demand)
```

---

## v3 Backlog

Event-driven Finn. Extends beyond "human invokes tool" to "system invokes workflow."

---

### Webhook / Pub-Sub Triggers

External events trigger Finn workflows automatically.

**Examples:**
- GitHub PR opened → `finn__fix` with lint results → posts comment
- CI failure → `finn__fix` with error logs
- Scheduled cron → `finn__plan` for repo health check

**Inspired by:** OpenClaw's webhook/cron/Gmail Pub-Sub integration.

**Enables:** CI/CD integration, scheduled maintenance, event-driven workflows.

---

### Run Queue + Prioritization

Manage multiple pending runs when webhooks/events trigger concurrently.

**Features:**
- Queue incoming runs
- Prioritize by criteria (PR age, size, author, workflow type)
- Concurrency control (`max_concurrent`)
- Deduplication (same PR triggered twice → merge)

**Prerequisite:** Webhook triggers (above).
