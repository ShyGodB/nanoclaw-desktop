# NanoClaw Desktop

Personal Claude assistant running on a real macOS desktop.

**IMPORTANT: Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) before modifying code.** It describes the full system: runtime parity, VirtioFS path mapping, topic isolation, IPC protocol, message flow, and concurrency model. This is the authoritative design document — not SPEC.md (which describes upstream only).

See also: [README.md](README.md) for user-facing docs, [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for upstream design philosophy.

## Quick Context

Single Node.js process that connects to Telegram, routes messages to Claude Code CLI (Agent SDK) running in a Lume macOS VM. Each Telegram Forum Topic auto-creates an isolated workspace, session, and IPC channel.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/telegram.ts` | Telegram bot connection, send/receive, topic routing |
| `src/lume-runner.ts` | Lume macOS VM agent runner (SSH + VirtioFS) |
| `src/container-runner.ts` | Apple Container / Docker agent runner (fallback) |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/group-queue.ts` | Per-group queue with concurrency control + IPC pipe |
| `src/task-scheduler.ts` | Runs scheduled tasks (runtime-aware) |
| `src/types.ts` | Topic isolation helpers (`getEffectiveFolder`, `getBaseFolder`) |
| `src/db.ts` | SQLite operations |
| `container/tools/patchright-browser.mjs` | Anti-detection browser with proxy support |
| `container/tools/proxy-manager.mjs` | Per-workspace proxy IP manager (Qingguo API) |
| `groups/*/CLAUDE.md.default` | Persona templates (tracked in git, "Andy" default) |
| `groups/*/CLAUDE.md` | Per-project memory (generated from .default, gitignored) |

## Skills

| Skill | When to Use |
|-------|-------------|
| `/setup-desktop` | First-time installation with Lume VM + Telegram |
| `/setup` | Original upstream setup (WhatsApp + Apple Container) |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |

## Fork Strategy

This repo is forked from `qwibitai/nanoclaw` (upstream). Long-term plan: rebase onto upstream once it stabilizes (tags/releases), then layer our additions on top. Until upstream has a stable version, do NOT merge or sync — develop independently.

Our additions over upstream: Telegram channel (replacing WhatsApp), Lume macOS VM runtime, Patchright anti-detection browser, per-workspace proxy IP isolation.

## Proxy IP System

Each workspace can have a `.proxy` file at `groups/{topic}/.browser-data/.proxy` to bind a dedicated residential proxy IP (via Qingguo/青果网络 long-term dynamic residential proxy). No `.proxy` = direct connection.

- **Credentials**: `QG_AUTH_KEY` / `QG_AUTH_PWD` in `.env` (see `.env.example`)
- **IP whitelist**: The machine's public IP must be added to Qingguo's auth whitelist (控制台 → 鉴权白名单)
- **Management**: `container/tools/proxy-manager.mjs` — assign/renew/list/release proxy IPs
- **Auto-renewal**: `patchright-browser.mjs` checks `.proxy` deadline at browser launch; renews if expired or within 1 hour of expiry
- **Architecture details**: See "Proxy IP Architecture" section in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

Service management:
```bash
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
```

## Container Build Cache

Apple Container's buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild:

```bash
container builder stop && container builder rm && container builder start
./container/build.sh
```

Always verify after rebuild: `container run -i --rm --entrypoint wc nanoclaw-agent:latest -l /app/src/index.ts`
