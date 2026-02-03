# Fix Agent (v1 Backlog)

Fixes issues with smart grouping for parallel/sequential execution.

**Input:** Issues (text or structured)
**Output:** Status per group, issues fixed + summary capsule (via Moss, for Claude Code handoff)

---

## Flow

```
┌─────────────┐
│Parse Issues │
└──────┬──────┘
       ▼
┌──────────────────────────────────────┐
│     GROUPING (Deterministic)         │
│                                      │
│  1. Map issues → files touched       │
│  2. Detect file overlaps             │
│  3. Build overlap graph              │
│  4. Connected components →           │
│     sequential groups                │
│  5. Isolated nodes →                 │
│     parallel groups                  │
└──────────────────────────────────────┘
       │
       ▼
┌─────────────┐
│  Init Run   │
│ + exec plan │
└──────┬──────┘
       │
       ├──────────────────────────────────────┐
       ▼                                      ▼
┌─────────────────────┐            ┌─────────────────────┐
│   PARALLEL GROUPS   │            │  SEQUENTIAL GROUPS  │
│                     │            │                     │
│  Promise.allSettled │            │    for...of         │
│  (concurrent)       │            │    (in order)       │
└──────────┬──────────┘            └──────────┬──────────┘
           │                                  │
           └────────────┬─────────────────────┘
                        ▼
          ┌────────────────────────────┐
          │     PER-GROUP PIPELINE     │
          │                            │
          │  design-verifier (loop)    │
          │         ↓                  │
          │  implement + test          │
          │         ↓                  │
          │  impl-verifier (loop)      │
          └────────────────────────────┘
                        │
                        ▼
               ┌─────────────┐
               │  Aggregate  │
               │   Results   │
               └─────────────┘
```

---

## Grouping Rules

| Condition | Execution |
|-----------|-----------|
| Issues touching same files | Sequential (changes might conflict) |
| Issues with no file overlap | Parallel |
| Related issues (same root cause) | Combined into single fix |

---

## Error Handling

| Failure | Handling |
|---------|----------|
| Single fix fails | Continue with other groups, report partial |
| Sequential group blocked | Stop that group, continue parallel groups |
| All fixes fail | Return error with details per group |
