# Claude Code Instructions

## Project: Finn
Deterministic workflows for Claude Code via Agent SDK + MCP.

## Tech Stack
TypeScript, Claude Agent SDK, MCP TypeScript SDK (@modelcontextprotocol/sdk), Moss (MCP client)

## MUST READ

Before working on this project, read these design documents:

**Build Order (active):**
1. `dev/BUILD.md` — Current build phases and stages (gitignored, follow this)

**Core:**
2. `docs/design/FINN.md` — Architecture, primitives, design principles
3. `docs/design/artifacts.md` — Artifact store interface and storage semantics

**Workflows:**
4. `docs/design/plan.md` — Plan workflow: fan-out explorers, fan-in, stitcher

## Reference (as needed)

- `docs/BACKLOG.md` — Future features and v1/v2/v3 scope
- `docs/design/artifact-backlog.md` — Deferred storage features

## Key Concepts
- **Agent SDK**: Programmatic orchestration with guaranteed parallelism, loop control, error handling
- **MCP Server**: Exposes `finn__plan`, `finn__feat`, `finn__fix` tools to Claude Code
- **Artifacts**: Finn's internal durable state for orchestration (typed JSON with TTL)
- **Moss**: External handoffs via Capsules (session summaries for humans/LLMs)

## Architecture

### Layer Separation

```
Finn ──→ Orchestration + State
  │       ├── Workflows (plan, feat, fix)
  │       └── Artifacts (internal durable state)
  │
  └── Moss ──→ External Handoffs (Capsules for humans/LLMs)
```

### Primitives

| Primitive | Owner | Consumer | Purpose |
|-----------|-------|----------|---------|
| **Artifacts** | Finn | Code | Structured JSON (`data`) + rendered view (`text`). Explorer findings, verifier outputs, run records, DLQ entries. |
| **Lore** | Finn | Code | Persistent artifacts for playbooks, pitfalls, repo-maps (v2). |
| **Capsules** | Moss | Humans/LLMs | 6-section markdown for session handoffs. Finn exports on demand. |

### Key Principle: Data is Truth, Text is View

```
data (typed JSON) ──→ source of truth, code operates on this
        │
        ▼
text (markdown) ────→ derived view for LLMs, auto-generatable
```

- **Finn code** reads `artifact.data` (sort, filter, dedupe)
- **Finn subagents (LLMs)** consume `artifact.text` via `artifact_compose`

### Terminology

| Term | Meaning |
|------|---------|
| **Artifact** | Structured state for code. Has `kind`, `data`, optional `text`. |
| **Lore** | Persistent artifacts (`workspace: "lore"`, no TTL). Playbooks, pitfalls, repo-maps (v2). |
| **Capsule** | Markdown handoff for humans/LLMs. 6-section format. |
| **Workspace** | Namespace with TTL default (`plan/`, `feat/`, `runs/`, `dlq/`, `lore/`). |
| **run_id** | Scopes artifacts to a single workflow execution. |
| **kind** | Artifact type (`explorer-finding`, `verifier-output`, `run-record`, `dlq-entry`, `playbook`, `pitfall`, `repo-map`). |

## Workflows

| Workflow | Pattern | Artifact Usage |
|----------|---------|----------------|
| **Plan** | Fan-out explorers → fan-in → stitch | Findings scoped by `run_id` |
| **Feat** | Design → impl → verify loops | Tracks review rounds |
| **Fix** | Grouping + parallel/sequential execution | Per fix session |

## Commands
```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript
npm run dev          # Development mode (watch)
npm test             # Run tests
npm run fmt          # Auto-fix format + lint (Biome)
npm run lint         # Check format + lint (no fix)
npm run typecheck    # Type check only
npm run check        # lint + typecheck (CI)
```

## Project Structure
```
finn/
├── src/
│   ├── index.ts              # MCP server entry
│   ├── server.ts             # Tool definitions
│   ├── workflows/
│   │   ├── plan.ts           # Plan: fan-out/fan-in/stitch
│   │   ├── feat.ts           # Feat: design/impl/verify loops
│   │   └── fix.ts            # Fix: grouping + execution
│   ├── subagents/
│   │   ├── explorers/        # code, test, doc, migration
│   │   ├── verifiers/        # design-verifier, impl-verifier
│   │   └── stitcher.ts
│   ├── grouping/
│   │   └── fix-grouper.ts    # Overlap analysis
│   ├── artifacts/
│   │   └── store.ts          # Artifact storage layer
│   └── moss/
│       └── client.ts         # Moss MCP client (for Capsule export)
├── package.json
└── tsconfig.json
```

## Guidelines
- Agent SDK for orchestration logic (loops, parallelism, error handling)
- MCP for Claude Code integration
- Artifacts for internal state management (Finn's storage layer)
- Moss for external handoffs (Capsules)
- Subagents are Agent SDK agents, not Claude Code Task subagents

## Docs
| Doc | Purpose |
|-----|---------|
| `docs/design/FINN.md` | Architecture, project structure |
| `docs/design/plan.md` | Plan workflow: fan-out/fan-in, explorers, stitcher |
| `docs/design/feat.md` | Feat workflow: design/impl/verify loops |
| `docs/design/fix.md` | Fix workflow: grouping, parallel/sequential execution |
| `docs/design/artifacts.md` | Artifacts: Finn's durable state layer |
| `docs/design/artifact-backlog.md` | Artifact store: deferred features |
| `docs/BACKLOG.md` | Future features and improvements |

## References
- [Agent SDK - TypeScript](https://platform.claude.com/docs/en/agent-sdk/typescript.md) — API reference
- [Agent SDK - Subagents](https://platform.claude.com/docs/en/agent-sdk/subagents.md) — Subagent patterns
- [MCP TypeScript SDK](https://modelcontextprotocol.io/docs/tools/typescript-sdk) — MCP server implementation
- [Moss](https://github.com/hpungsan/moss) — External handoffs via Capsules
