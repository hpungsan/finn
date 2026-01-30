# Claude Code Instructions

## Project: Finn
Deterministic workflow agents for Claude Code via Agent SDK + MCP.

## Tech Stack
TypeScript, Claude Agent SDK, MCP TypeScript SDK (@modelcontextprotocol/sdk), Moss (MCP client)

## Key Concepts
- **Agent SDK**: Programmatic orchestration with guaranteed parallelism, loop control, error handling
- **MCP Server**: Exposes `finn__plan`, `finn__feat`, `finn__fix` tools to Claude Code
- **Moss Integration**: Capsules track state across agents via `run_id`, `phase`, `role`

## Agents

| Agent | Pattern | Moss Usage |
|-------|---------|------------|
| **Plan** | Fan-out explorers → fan-in → stitch | `run_id` scoping, `inventory`, `compose` |
| **Feat** | Design → impl → verify loops | Capsule tracks review rounds |
| **Fix** | Grouping + parallel/sequential execution | Capsule per fix session |

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
│   ├── agents/
│   │   ├── plan.ts           # Plan: fan-out/fan-in/stitch
│   │   ├── feat.ts           # Feat: design/impl/verify loops
│   │   └── fix.ts            # Fix: grouping + execution
│   ├── subagents/
│   │   ├── explorers/        # code, test, doc, migration
│   │   ├── verifiers/        # design-verifier, impl-verifier
│   │   └── stitcher.ts
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
| `docs/DESIGN.md` | Architecture, agent flows, Moss integration |
| `docs/BACKLOG.md` | Future features and improvements |

## Related Projects
- [Moss](https://github.com/hpungsan/moss) — Context capsules for agent coordination
