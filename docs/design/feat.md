# Feat Agent (v1 Backlog)

Implements a feature from a plan file with design review and verification loops.

**Input:** Plan file path
**Output:** Status, files changed + summary capsule (Moss, for Claude Code handoff)

---

## Flow

```
┌─────────────┐
│  Read Plan  │
│  Init Run   │
└──────┬──────┘
       ▼
┌──────────────────────────────────────┐
│      DESIGN REVIEW LOOP (max 2)      │
│                                      │
│  ┌──────────────────────────────┐    │
│  │  Spawn design-verifier       │    │
│  │  (reads prior artifacts)     │    │
│  └─────────────┬────────────────┘    │
│                ▼                     │
│         ┌───────────┐                │
│         │ APPROVE?  │── yes ─────────┼──→ exit
│         └─────┬─────┘                │
│               │ no                   │
│               ▼                      │
│  round < 2? → adjust plan, loop      │
│  round = 2? → BLOCKED                │
└──────────────────────────────────────┘
       │
       ▼
┌─────────────┐
│ Implement   │
│ (code, test,│
│  lint)      │
└──────┬──────┘
       ▼
┌──────────────────────────────────────┐
│     VERIFICATION LOOP (max 2)        │
│                                      │
│  ┌──────────────────────────────┐    │
│  │  Spawn impl-verifier         │    │
│  │  (sees design concerns)      │    │
│  └─────────────┬────────────────┘    │
│                ▼                     │
│         ┌───────────┐                │
│         │ VERIFIED? │── yes ─────────┼──→ exit
│         └─────┬─────┘                │
│               │ no                   │
│               ▼                      │
│  round < 2? → fix issues, loop       │
│  round = 2? → PARTIAL                │
└──────────────────────────────────────┘
       │
       ▼
┌─────────────┐
│  Complete   │
│   Return    │
└─────────────┘
```

---

## Verifiers

| Subagent | Purpose | Memory |
|----------|---------|--------|
| **design-verifier** | Review plans before implementation. Catches shallow/flawed approaches. | Artifact tracks concerns across rounds |
| **impl-verifier** | Verify implementation addresses design concerns. Distinguishes real fixes from workarounds. | Sees design concerns, tracks verification |

---

## Error Handling

| Failure | Handling |
|---------|----------|
| Design blocked after 2 rounds | Return BLOCKED status, surface concerns |
| Verification fails after 2 rounds | Return PARTIAL status, list remaining issues |
| Verifier timeout | Retry once, then continue with warning |
