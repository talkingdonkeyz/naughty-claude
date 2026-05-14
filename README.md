# naughty-claude

Starting June 15th, Claude Code costs roughly 40× more to use programmatically than interactively. Same model, same harness, ~40× the bill — because one bill is "interactive" and the other is "scripts." This is, in my opinion, fucking stupid. The whole point of the terminal as a form factor is that programs compose. Locking an agent behind a TUI and then pricing against composition is a unix hate crime.

naughty-claude drives Claude Code's interactive TUI programmatically. Same subscription, same auth, same agent with your editor, your scripts, your orchestration. The goal is a full [ACP](https://agentclientprotocol.com) server that exposes a session to any ACP-compatible client.

> Not affiliated with or endorsed by Anthropic, PBC.
> Claude and Claude Code are trademarks of their respective owners.

## Will this get me banned?

If you're using this for human-in-the-loop editor integration — a person typing in Zed, T3 Code or another ACP client and reading the response — we aim to be indistinguishable from a TUI user on both sides of the wire. Server-side, the prompts, turn cadence, and tool-use patterns are identical because it's the same human doing the same work. Locally, the library targets zero fingerprinting — nothing on the machine should reveal that the bytes reaching `claude`'s stdin came from anywhere other than a terminal. Docker is how we get there.

If you're using this for automation, those guarantees don't hold. Sustained throughput, parallel sessions, prompt patterns that obviously aren't human — all observable server-side regardless of what client you use. You assume that risk.

### How the local hardening works

The defenses are scoped to local fingerprinting: making sure nothing about how naughty-claude drives `claude` is visible to `claude` or to any other process on the same machine.

The hardening layer is a Docker wrapper. Claude runs inside a container with only tmux and a workspace volume; the parser process on the host drives the container-side tmux through a shared socket. From inside claude, the orchestrator is invisible — PID and mount namespaces hide it completely. The container itself is detectable as a container, but that's not specifically a naughty-claude signal: it's common to run `claude` inside a container to isolate it so the permisions `--dangerously-skip-permissions` trade off is sane. Container presence is a population-wide feature, not a fingerprint.

The same posture applies to the library's own artifacts inside and outside the container — nothing in the process landscape carries the project's brand:

- Tmux socket names default to plausibility-randomized values that look like things users would actually pick (`dev`, `work`, `agent`), not `naughty-claude` or any obvious project marker.
- Temp files (logs, pipes) use `mktemp`-style names with no project prefix.
- Tmux session and pane names are left to tmux's defaults — no `claude-*` prefixes.
- The Node process sets `process.title` to a generic name.
- No custom environment variables; no runtime artifacts contain the project's brand. The brand lives in the package name and this README; it does not leak into the process landscape.

Sandboxing is opt-in via `--sandbox docker` (recommended). A `--sandbox none` mode runs claude directly on the host with no isolation. Faster, simpler, riskier — the orchestrator process, temp files, and tmux socket are all visible to anything `claude` decides to look at. Suitable while this project is irrelevant and therefore not finger printed.

The behavioral fingerprint is unchanged by either mode: server-side cadence, input shape, and per-account session concentration are functions of how the product is used, not how it's implemented. In HITL these stay indistinguishable from native TUI use; in automation they don't.

### Disclaimer

This is best-effort threat modeling, not a guarantee. The Anthropic TOS applies to your use of Claude Code regardless of what drives it. The library aims not to be the proximate cause of any account action; it can't promise outcomes.

## Install

Not on npm yet. Clone the repo, install deps, build:

```bash
bun install      # or: npm install
bun run build    # or: npm run build
```

## Roadmap

ACP is the first reference application built on the foundation; other consumers (REST wrappers, batch tools, multi-agent orchestration) are possible on the same primitives. The work splits cleanly along two orthogonal axes: mediation (items 1 and 2) and hardening (item 3).

### 1. TUI parser

Today the driver reads from the transcript JSONL file. That gives clean structure (tool calls, message IDs, `stop_reason`) but only updates per content block — you see a full paragraph at a time, not tokens. Meanwhile, tmux already exposes the live pane bytes via `subscribe()`, which contains tokens as Claude renders them, plus everything else happening in the UI.

The parser is a small terminal emulator that consumes the byte stream and recognizes a handful of states:

- streaming assistant text (the streaming UX)
- tool-call announcements
- permission dialogs (the mediation point — see below)
- the "ready for input" state

The transcript stays in the picture as structural ground truth: what claude is doing, which message IDs, when a turn closed. The TUI tells us when each of those things happens and surfaces the interactive states the transcript doesn't capture. Two channels, complementary.

### 2. ACP agent

A JSON-RPC stdio server (LSP-style Content-Length framing) implementing the agent half of ACP. Thin layer on top of the parser:

- `initialize`, `authenticate` (no-op), `session/new`, `session/prompt`, `session/cancel`, `session/set_mode`
- `session/update` notifications driven by parser + transcript:
  - assistant text deltas → `agent_message_chunk`
  - tool_use blocks → `tool_call`
  - tool_result blocks → `tool_call_update`
  - terminal `stop_reason` → `session/prompt` response payload
- `session/request_permission` triggered when the parser detects claude's permission dialog. The client's response is translated to a keystroke and sent into the pane. Claude's own permission system is the gate; ACP just routes it.

No `fs/*` or `terminal/*` client capabilities are advertised. The client gates resource access via the permission flow; it doesn't own the resources.

### 3. Docker hardening

Orthogonal to 1 and 2. Wraps the runtime so claude executes inside a container with a shared tmux socket and a workspace volume. The parser process stays on the host and drives the container-side tmux through the socket exactly as it drives a local tmux today. PID and mount namespaces hide the orchestrator from anything looking around inside claude's view.

Shipped as a sibling tool / CLI flag (`--sandbox docker`), not as part of the TS library API. The library knows nothing about docker; the wrapper knows nothing about ACP. They compose by sharing the tmux socket location.

A `--sandbox none` mode exists for development and trusted local use, with explicit warnings that the orchestrator is locally visible in that configuration.

## Contributing

Issues and PRs welcome. 