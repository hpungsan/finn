# Finn

Deterministic workflow agents for Claude Code.

## Background

I built [Moss](https://github.com/hpungsan/moss) to handle context handoffs between AI sessions. Once I had persistent state, I started building more complex workflows on top of it — skills like `/feat` and `/fix` that use Moss capsules to track design reviews, implementation progress, and verification loops with structured feedback.

## Problem

The skills work on the happy path. But prompt-based skills have no error model.

When I spawn a subagent via Task tool and it times out, fails mid-execution, or returns malformed output — how do I handle that in a skill? I can't. There's no try/catch. The skill says "spawn subagent" and hopes for the best. If it fails, the whole flow is in an undefined state.

Skills are imperative scripts that assume success at every step. I wanted guarantees.

## Solution

Move orchestration logic to TypeScript code while preserving Claude Code UX.

- **Agent SDK** — Programmatic control over agent execution (`Promise.allSettled`, `for` loops, `try/catch`)
- **MCP** — Expose agents as tools to Claude Code (user still types `/plan`, `/feat`, `/fix`)
- **[Moss](https://github.com/hpungsan/moss)** — State management between agents (capsules scoped by `run_id`)

User experience stays the same. Execution becomes deterministic.

## Agents

| Agent | Purpose | Based On |
|-------|---------|----------|
| **Plan** | Fan-out parallel explorers → fan-in → stitch into comprehensive plan | New |
| **Feat** | Design review → implement → verify loops with enforced round limits | `.claude/skills/feature` |
| **Fix** | Smart grouping (parallel vs sequential) based on file overlap | `.claude/skills/fix` |

## Status

Work in progress. See `dev/DESIGN.md` for architecture and `dev/BACKLOG.md` for roadmap.

## Tech Stack

- TypeScript
- [Claude Agent SDK](https://github.com/anthropics/agent-sdk)
- [MCP TypeScript SDK](https://modelcontextprotocol.io/docs/tools/typescript-sdk)
- [Moss](https://github.com/hpungsan/moss) for agent coordination

## Related

- [Moss](https://github.com/hpungsan/moss) — Local context capsule store for AI session handoffs
