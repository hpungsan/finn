# Plan Agent

Explores codebase via parallel subagents and synthesizes comprehensive plan.

**Input:** Task description (string)
**Output:** Plan file (disk) + summary capsule (via Moss, for Claude Code handoff)

---

## Flow

```
┌───────────────────────────────────────────────────────────────────────┐
│                           INIT                                        │
│                                                                       │
│   run_id = "plan-{slug}-{timestamp}"                                  │
│   artifact_store({ workspace: "runs", name: run_id,                   │
│                    kind: "run-record", data: { status: "RUNNING" } }) │
└───────────────────────────────────────────────────────────────────────┘
       │
       ▼
┌───────────────────────────────────────────────────────────────────────┐
│                        FAN OUT (parallel)                             │
│                                                                       │
│   Concurrency: semaphore (default 4)                                  │
│   Per explorer: record step RUNNING → run → store step-result         │
│                                                                       │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌───────────────┐ │
│  │code-explorer │ │test-explorer │ │ doc-explorer │ │migration-expl │ │
│  └──────┬───────┘ └──────┬───────┘ └──────┬───────┘ └───────┬───────┘ │
│         │                │                │                 │         │
│         ▼                ▼                ▼                 ▼         │
│   artifact_store   artifact_store   artifact_store   artifact_store  │
│   kind: "explorer-finding"                                            │
│   name: "{run_id}-{role}"                                             │
│   data: { files[], patterns[], concerns[], confidence }               │
│   text: rendered markdown for stitcher                                │
│   ttl: 1 hour (ephemeral)                                             │
└───────────────────────────────────────────────────────────────────────┘
       │
       ▼
┌───────────────────────────────────────────────────────────────────────┐
│                        FAN IN (gather + process)                      │
│                                                                       │
│   artifact_list({ run_id, kind: "explorer-finding" })                 │
│   → returns data (not just metadata)                                  │
│                                                                       │
│   Code operates on structured data:                                   │
│   - Sort by role, then by data.confidence                             │
│   - Dedupe overlapping files (merge summaries)                        │
│   - Filter low-confidence findings if over budget                     │
│                                                                       │
│   artifact_compose({ items: [...], format: "markdown" })              │
│   → bundle_text for stitcher context                                  │
└───────────────────────────────────────────────────────────────────────┘
       │
       ▼
┌───────────────────────────────────────────────────────────────────────┐
│                        STITCH (synthesize)                            │
│                                                                       │
│   Input: bundle_text (all explorer findings as markdown)              │
│   Output: comprehensive plan markdown                                 │
│                                                                       │
│   Stitcher is a subagent (LLM) — combines, dedupes, orders            │
└───────────────────────────────────────────────────────────────────────┘
       │
       ▼
┌───────────────────────────────────────────────────────────────────────┐
│                           FINALIZE                                    │
│                                                                       │
│   1. Write plan file to disk: dev/plans/{slug}.md                     │
│   2. Update run-record: status → OK, artifact_ids                     │
│   3. Store summary capsule (external handoff to Claude Code)          │
│   4. Ephemeral artifacts auto-expire via TTL                          │
└───────────────────────────────────────────────────────────────────────┘
```

---

## Explorers

| Subagent | Focus | Checklist |
|----------|-------|-----------|
| **code-explorer** | Code changes | Files to modify, patterns to follow, dependencies, constraints |
| **test-explorer** | Test coverage | Test files needed, edge cases, coverage gaps |
| **doc-explorer** | Documentation | README, API docs, CHANGELOG, inline comments |
| **migration-explorer** | Breaking changes | Deprecations, upgrade path, backwards compatibility |

---

## Stitcher

Combines explorer findings into coherent, comprehensive plan.

**Input:** Bundled findings from all explorers (via `artifact_compose`)
**Output:** Markdown plan file

**Responsibilities:**
- Deduplicate overlapping recommendations
- Order steps logically (dependencies first)
- Flag conflicts between explorer recommendations
- Ensure nothing from any explorer is dropped

### Plan Output Structure

```markdown
# Plan: {task}

## Overview
{synthesized summary}

## Code Changes
{from code-explorer}

## Tests
{from test-explorer}

## Documentation
{from doc-explorer}

## Migration / Breaking Changes
{from migration-explorer, if any}

## Dependencies & Order
{stitcher-determined sequence}
```

---

## Error Handling

| Failure | Handling |
|---------|----------|
| Explorer times out | Continue with other findings, mark partial |
| Explorer crashes | Log error, continue with other findings |
| All explorers fail | Return error, no plan generated |
| Stitcher fails | Return raw findings, let user stitch manually |
| Artifact store unavailable | Fallback to in-memory state (degraded) |
