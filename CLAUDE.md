# Claude Code Instructions

## Project: Finn
Deterministic workflows for Claude Code via Agent SDK + MCP.

## Tech Stack
TypeScript, Claude Agent SDK, MCP TypeScript SDK (@modelcontextprotocol/sdk), Moss (MCP client)

## Key Concepts
- **Agent SDK**: Programmatic orchestration with guaranteed parallelism, loop control, error handling
- **MCP Server**: Exposes `finn__plan`, `finn__feat`, `finn__fix` tools to Claude Code
- **Moss**: State management via Artifacts (see Finn-Moss Architecture below)

## Finn-Moss Architecture

### Layer Separation

```
Finn ──→ Orchestration (code controls flow, spawns subagents, enforces limits)
  │
  └── Moss ──→ State (stores artifacts, manages lifecycle, enables coordination)
```

Finn drives requirements. Moss provides primitives. Finn should not contort to fit Moss limitations — if Moss lacks a primitive, either add it to Moss or question whether Moss is the right layer.

### Moss Primitives

| Primitive | Consumer | v1 Scope | Purpose |
|-----------|----------|----------|---------|
| **Artifacts** | Code | ✓ | Structured JSON (`data`) + rendered view (`text`). Explorer findings, verifier outputs, run records, DLQ entries. |
| **Capsules** | Humans/LLMs | External only | 6-section markdown for session handoffs. Finn v1 doesn't store capsules — exports on demand. |
| **Pods** | Humans/LLMs | v2 | Long-lived knowledge (playbooks, pitfalls, repo maps). |

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
| **Capsule** | Markdown handoff for humans/LLMs. 6-section format. |
| **Pod** | Long-lived knowledge (v2). |
| **Workspace** | Namespace with TTL default (`plan/`, `feat/`, `runs/`, `dlq/`). |
| **run_id** | Scopes artifacts to a single workflow execution. |
| **kind** | Artifact type (`explorer-finding`, `verifier-output`, `run-record`, `dlq-entry`). |

## Workflows

| Workflow | Pattern | Moss Usage |
|----------|---------|------------|
| **Plan** | Fan-out explorers → fan-in → stitch | Artifacts via `run_id`, `artifact_compose` |
| **Feat** | Design → impl → verify loops | Artifact tracks review rounds |
| **Fix** | Grouping + parallel/sequential execution | Artifact per fix session |

## Commands
```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript
npm run dev          # Development mode
npm test             # Run tests
npm run lint         # Lint code
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
│   └── moss/
│       └── client.ts         # Moss MCP client wrapper
├── package.json
└── tsconfig.json
```

## Guidelines
- Agent SDK for orchestration logic (loops, parallelism, error handling)
- MCP for Claude Code integration
- Moss for state management between agents
- Subagents are Agent SDK agents, not Claude Code Task subagents

## Docs
| Doc | Purpose |
|-----|---------|
| `docs/design/FINN.md` | Architecture, Moss integration, project structure |
| `docs/design/plan.md` | Plan workflow: fan-out/fan-in, explorers, stitcher |
| `docs/design/feat.md` | Feat workflow: design/impl/verify loops |
| `docs/design/fix.md` | Fix workflow: grouping, parallel/sequential execution |
| `dev/moss/artifact.md` | Moss Artifacts: structured state for code consumers |
| `docs/BACKLOG.md` | Future features and improvements |

## References
- [Agent SDK - TypeScript](https://platform.claude.com/docs/en/agent-sdk/typescript.md) — API reference
- [Agent SDK - Subagents](https://platform.claude.com/docs/en/agent-sdk/subagents.md) — Subagent patterns
- [MCP TypeScript SDK](https://modelcontextprotocol.io/docs/tools/typescript-sdk) — MCP server implementation
- [Moss](https://github.com/hpungsan/moss) — State management for workflow coordination
