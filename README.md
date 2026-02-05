# Finn

Deterministic orchestration for Claude Code.

## Background

I built [Moss](https://github.com/hpungsan/moss) to handle context handoffs between AI sessions. Once I had persistent state, I started building more complex workflows on top of it — skills like `/feat` and `/fix` that use Moss capsules to track design reviews, implementation progress, and verification loops with structured feedback.

## Problem

Prompt-based skills can't guarantee execution. No try/catch, no enforced loops, no reliable parallelism. I wanted deterministic control flow.

## Solution

**Subagents do the thinking.** Explorers, verifiers, and stitchers are LLMs that make judgment calls — "what's relevant?", "is this correct?", "how do I combine these findings?"

**Code does the routing.** Loops, fan-out/fan-in, timeouts, retries — all enforced by code, not suggested by prompts.

Same UX, deterministic control flow.

## How It Works

- **Artifacts** — Internal durable state (typed JSON, scoped by `run_id`, TTL-managed)
- **[Moss](https://github.com/hpungsan/moss)** — External handoffs via capsules
- **Agent SDK + MCP** — Programmatic orchestration exposed as Claude Code tools

## Workflows

| Workflow | Purpose | Pattern |
|----------|---------|---------|
| **Plan** | Comprehensive planning with full coverage | Fan-out parallel explorers → fan-in → stitch |
| **Feat** | Implementation with design review loops | Design → implement → verify (enforced rounds) |
| **Fix** | Smart fix execution based on file overlap | Group → parallel or sequential execution |

## Tech Stack

- TypeScript
- [Claude Agent SDK](https://github.com/anthropics/agent-sdk)
- [MCP TypeScript SDK](https://modelcontextprotocol.io/docs/tools/typescript-sdk)
- [Moss](https://github.com/hpungsan/moss) for external handoffs (capsules)

## Roadmap

### v1 — Deterministic Orchestration
Code-based hardening, no new LLM components.

**Core** (see [FINN.md](docs/design/FINN.md)):
- Run Record, rounds vs retries, structured output (Zod)

**Backlog:**
- Concurrency controls, basic replay, tripwires, DLQ + resume, auto mode

### v2 — Meta Layer
Optional components that consume traces and update Finn's inputs:
- Meta-supervisor (escalation-only LLM for blocked states)
- Run Finalizer (extract lore from runs)
- Lore (persistent artifacts: playbooks, pitfalls, repo-maps)
- Optimization Pipeline (improve prompts/policies from traces)

See [docs/BACKLOG.md](docs/BACKLOG.md) for details.

## License

MIT
