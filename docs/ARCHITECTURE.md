# NanoClaw Desktop — Architecture

> This is the authoritative architecture document for the Desktop fork. Read this before modifying any code. It describes the actual running system, not upstream's original design.

## Overview

NanoClaw Desktop is a personal Claude assistant running on macOS. A single Node.js orchestrator process on the host connects to Telegram, manages message queues, and spawns agent sessions inside a long-lived Lume macOS VM via SSH. The agent (Claude Code SDK) runs in an isolated workspace with per-topic separation.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        HOST (macOS, Node.js)                           │
│                                                                        │
│  Telegram ←→ SQLite DB ←→ Message Loop ──→ GroupQueue (concurrency)    │
│                                │               │                       │
│                          Scheduler Loop    IPC Watcher                  │
│                                │           (polls data/ipc/)           │
│                                └──────┬───────┘                        │
│                                       │ spawn SSH                      │
├───────────────────────────────────────┼────────────────────────────────┤
│                    LUME VM (macOS, SSH)│                                │
│                                       ▼                                │
│   /Volumes/My Shared Files/ ← VirtioFS mount of PROJECT_ROOT          │
│                                                                        │
│   ~/workspace/              ← symlinks into shared dir (per run)       │
│     ├── group/   → shared/groups/{effectiveFolder}/                    │
│     ├── global/  → shared/groups/global/                               │
│     ├── ipc/     → shared/data/ipc/{effectiveFolder}/                  │
│     ├── sessions/→ shared/data/sessions/{effectiveFolder}/             │
│     ├── project/ → shared/ (main only)                                 │
│     ├── agent-runner/ → ~/local/agent-runner/  (SCP deploy)            │
│     └── tools/        → ~/local/tools/         (SCP deploy)            │
│                                                                        │
│   ~/.claude/    → shared/data/sessions/{effectiveFolder}/.claude       │
│                    (settings.json, skills/, session transcripts)        │
│                                                                        │
│   agent-runner  ← reads stdin JSON, queries Claude SDK,                │
│                    writes stdout markers, polls ipc/input/              │
└────────────────────────────────────────────────────────────────────────┘
```

## Two Runtimes

The project supports two agent runtimes. Each registered group has a `runtime` field (`'container'` or `'lume'`). The Desktop fork uses `'lume'` exclusively.

| Aspect | container-runner (upstream) | lume-runner (Desktop) |
|--------|---------------------------|----------------------|
| Platform | Apple Container (Linux VM) | Lume macOS VM (SSH) |
| Isolation | Per-invocation container | Shared VM, per-run symlink setup |
| Filesystem | Volume mounts (`-v`, `--mount`) | VirtioFS shared dir + symlinks |
| User | `node` (Linux) | `lume` (macOS) |
| `~/.claude/` | Mounted from host | Symlinked to shared dir |
| Browser | Headless Chromium in container | Headed Chrome via Playwright (anti-detection) |
| Concurrency | Multiple containers in parallel | Single VM, symlinks overwritten per run |

### Initialization Parity

Both runtimes must perform the same initialization before launching the agent-runner. This is the most common source of bugs when they diverge.

**Host-side prep** (before SSH / container spawn):

| Step | container-runner | lume-runner |
|------|-----------------|-------------|
| Create IPC dirs | `data/ipc/{ef}/messages,tasks,input` | Same |
| Create group dir | `groups/{ef}/` | Same |
| Create session dir | `data/sessions/{ef}/.claude/` | Same |
| Write `settings.json` | If not exists → env config JSON | Same |
| Sync skills | Copy `container/skills/*/` → `.claude/skills/` | Same |
| Write tasks snapshot | `data/ipc/{ef}/current_tasks.json` | Same (in index.ts) |
| Write groups snapshot | `data/ipc/{ef}/available_groups.json` | Same (in index.ts) |

**Runtime-side setup** (inside container / SSH command):

| Step | container-runner | lume-runner |
|------|-----------------|-------------|
| Mount group dir | `-v groups/{ef}:/workspace/group` | `ln -sf shared/groups/{ef} ws/group` |
| Mount global dir | `--mount ...,target=/workspace/global,readonly` | `ln -sf shared/groups/global ws/global` |
| Mount IPC dir | `-v data/ipc/{ef}:/workspace/ipc` | `ln -sf shared/data/ipc/{ef} ws/ipc` |
| Mount sessions | `-v data/sessions/{ef}/.claude:/home/node/.claude` | `ln -sf shared/data/sessions/{ef} ws/sessions` |
| Set `~/.claude` | Implicit (mount target IS `$HOME/.claude`) | `rm -rf ~/.claude && ln -sf .../.claude ~/.claude` |
| Mount project root | `-v projectRoot:/workspace/project` (main only) | `rm -rf ws/project && ln -sf shared ws/project` (main) |
| Mount agent-runner | `--mount ...,target=/app/src,readonly` | `ln -sf ~/local/agent-runner ws/agent-runner` (SCP deploy) |
| Mount tools | N/A (tools in container image) | `ln -sf ~/local/tools ws/tools` (SCP deploy) |
| Auth env vars | Filtered `.env` → mounted file, sourced | SSH exports from host `.env` |
| Browser path | N/A (container has Chromium pre-installed) | Dynamic `find` in ms-playwright cache |

> **Key invariant:** The agent-runner always sees the same workspace layout regardless of runtime: `WORKSPACE_BASE/group/`, `WORKSPACE_BASE/ipc/`, `WORKSPACE_BASE/global/`, and `$HOME/.claude/` with settings + skills.

## Path Mapping: Host ↔ VM

The Lume VM mounts the host's project root via VirtioFS at `/Volumes/My Shared Files/`. All data sharing goes through this single mount point.

```
HOST PATH                                    VM PATH (via VirtioFS)
─────────────────────────────────────────    ──────────────────────────────────────
{PROJECT_ROOT}/                              /Volumes/My Shared Files/
├── groups/{ef}/                         →   ~/workspace/group/  (symlink)
├── groups/global/                       →   ~/workspace/global/ (symlink)
├── data/ipc/{ef}/                       →   ~/workspace/ipc/    (symlink)
│   ├── messages/    ← agent writes      │
│   ├── tasks/       ← agent writes      │
│   └── input/       ← host writes       │
├── data/sessions/{ef}/.claude/          →   ~/.claude/          (symlink)
│   ├── settings.json                    │
│   ├── skills/                          │
│   └── *.jsonl (session transcripts)    │
├── container/agent-runner/  (source)   →   ~/local/agent-runner/  (SCP deploy)
│                                       →   ~/workspace/agent-runner/ (symlink → ~/local/...)
└── container/tools/        (source)    →   ~/local/tools/         (SCP deploy)
                                        →   ~/workspace/tools/ (symlink → ~/local/...)

Notation: {ef} = effectiveFolder (e.g. "andy-workspace~t16")
```

### VirtioFS Caveats

- **Caching:** VirtioFS caches aggressively. After modifying files on the host, the VM may still read stale content. **Code paths** (agent-runner, tools) are deployed via SCP to `~/local/` on the VM to bypass this — see `container/agent-runner/deploy.sh` and `container/tools/deploy.sh`. **Runtime-generated data** (IPC, sessions) works fine since files are written fresh. **Persistent data files** (e.g. `CLAUDE.md`) are also affected — the only reliable fix is a VM restart (clears the VirtioFS page cache).
- **VM restart procedure:** Always restart via the nanoclaw service, never manually. Manual `lume run` will miss `--shared-dir` (VirtioFS won't mount) and patchright-browser requires a display (no `--no-display`). Correct procedure: `lume stop my-vm` → restart the nanoclaw service.
- **Symlink into symlink:** `ln -sf target existing-symlink-to-dir` creates the link *inside* the directory instead of replacing it. Always `rm -rf` before `ln -sf`.

## Topic Isolation Model

Telegram Forum Topics provide per-conversation isolation within a single group registration. One group registration spawns many independent workspaces.

```
Telegram Group: "Andy workspace" (registered as tg:-1003897363949)
  ├── General topic  → JID: tg:-1003897363949      → folder: andy-workspace
  ├── Topic #16      → JID: tg:-1003897363949/16   → folder: andy-workspace~t16
  ├── Topic #145     → JID: tg:-1003897363949/145  → folder: andy-workspace~t145
  └── Topic #892     → JID: tg:-1003897363949/892  → folder: andy-workspace~t892
```

**Path derivation functions** (in `src/types.ts`):

| Function | Input | Output | Purpose |
|----------|-------|--------|---------|
| `extractTopicId(jid)` | `tg:-100.../16` | `"16"` | Get topic thread ID |
| `getEffectiveFolder(folder, jid)` | `"andy-workspace"`, `".../16"` | `"andy-workspace~t16"` | Derive isolated folder |
| `getBaseFolder(ef)` | `"andy-workspace~t16"` | `"andy-workspace"` | Recover base folder |
| `stripTopicSuffix(jid)` | `tg:-100.../16` | `tg:-100...` | Get base group JID |

**What's isolated per topic:**
- Working directory: `groups/{ef}/`
- IPC channels: `data/ipc/{ef}/`
- Session (conversation history): `data/sessions/{ef}/.claude/`
- CLAUDE.md memory: `groups/{ef}/CLAUDE.md`

**What's shared across topics:**
- Group registration (single entry in DB, base JID)
- Global memory: `groups/global/CLAUDE.md`
- Runtime config (container vs lume)

## Message Flow

### Inbound: Telegram → Agent

```
1. Telegram message arrives
   │  TelegramChannel.on('message:text')
   │  Builds composite JID: tg:{chatId}/{threadId}
   │
2. Store to SQLite
   │  onMessage() → storeMessage()
   │  onChatMetadata() → storeChatMetadata()
   │
3. Message loop polls SQLite (every 2s)
   │  getNewMessages(registeredJids, lastTimestamp)
   │  Checks trigger: /^@Andy\b/i
   │
4. GroupQueue.enqueueMessageCheck(chatJid)
   │  Concurrency limit: MAX_CONCURRENT_CONTAINERS (default 5)
   │  Per-group: queue if already active, retry with backoff on error
   │
5. processGroupMessages(chatJid)
   │  getMessagesSince(chatJid, lastAgentTimestamp) — catch-up all missed messages
   │  formatMessages() → XML: <messages><message sender="..." time="...">...</message></messages>
   │
6. runAgent(group, prompt, chatJid)
   │  writeTasksSnapshot() + writeGroupsSnapshot()
   │  Select runtime: group.runtime === 'lume' ? runLumeAgent : runContainerAgent
   │
7. runLumeAgent()
   │  prepareVmWorkspace() — host-side dirs, settings.json, skills
   │  buildSshCommand() — symlink setup + agent-runner launch
   │  spawn('ssh', [...]) — pipe stdin JSON, parse stdout markers
   │
8. Agent-runner inside VM
   │  Reads stdin → ContainerInput JSON
   │  query(SDK) with cwd=/workspace/group, resume=sessionId
   │  Loads ~/.claude/settings.json (settingSources: ['project', 'user'])
   │  Loads /workspace/global/CLAUDE.md as system prompt append
   │  Emits results via stdout markers
   │
9. Host parses stdout markers
   │  ContainerOutput JSON between ---NANOCLAW_OUTPUT_START/END---
   │  Strips <internal>...</internal> tags
   │  Sends to Telegram via channel.sendMessage(chatJid, text)
```

### Follow-up Messages (Piping)

While an agent is active, new messages bypass the spawn cycle and are piped in:

```
Host: GroupQueue.sendMessage(chatJid, text)
  → writes JSON to data/ipc/{ef}/input/{timestamp}-{random}.json

Agent-runner: polls ipc/input/ every 500ms
  → drains files, pushes text into MessageStream
  → SDK receives as new user turn mid-conversation
```

### Idle Shutdown

```
Agent finishes responding → host starts IDLE_TIMEOUT (30min default)
  → If no new messages: writes data/ipc/{ef}/input/_close sentinel
  → Agent-runner sees _close, exits query loop, process exits
  → SSH connection closes, host resolves Promise
```

## IPC Protocol

All IPC is file-based, through `data/ipc/{effectiveFolder}/`. The host polls this directory.

### Directions

| Direction | Path | Writer | Reader |
|-----------|------|--------|--------|
| Host → Agent | `ipc/input/*.json` | Host (GroupQueue) | Agent (poll loop) |
| Host → Agent | `ipc/input/_close` | Host (idle timer) | Agent (sentinel check) |
| Agent → Host | `ipc/messages/*.json` | Agent (MCP tools) | Host (IPC watcher) |
| Agent → Host | `ipc/tasks/*.json` | Agent (MCP tools) | Host (IPC watcher) |
| Host → Agent | `ipc/current_tasks.json` | Host (snapshot) | Agent (list_tasks tool) |
| Host → Agent | `ipc/available_groups.json` | Host (snapshot) | Agent (group info) |

### Message Types (agent → host)

| Type | Fields | Effect |
|------|--------|--------|
| `message` | `chatJid, text, sender?` | Send text to Telegram chat |
| `photo` | `chatJid, imagePath, caption?` | Send photo to Telegram chat |
| `schedule_task` | `prompt, schedule_type, schedule_value, targetJid, ...` | Create scheduled task |
| `pause_task` | `taskId` | Pause a scheduled task |
| `resume_task` | `taskId` | Resume a paused task |
| `cancel_task` | `taskId` | Delete a scheduled task |
| `register_group` | `jid, name, folder, trigger` | Register new group (main only) |
| `refresh_groups` | (none) | Re-sync group metadata (main only) |

### Photo Path Resolution (IPC watcher)

Photos sent by the agent use VM-internal paths that must be resolved to host paths:

```
Agent writes:  imagePath = "/Users/lume/workspace/group/screenshot.png"

Host resolves (in order):
  1. startsWith('/workspace/group/')      → container path → GROUPS_DIR/{ef}/...
  2. startsWith('/workspace/extra/')      → extra mount path
  3. includes('/workspace/group/')        → Lume VM path → extract relative, join with GROUPS_DIR
  4. isAbsolute && existsOnHost           → use directly
  5. else                                 → log warning, skip
```

## Agent-Runner Internals

The agent-runner (`container/agent-runner/`) is shared code that runs inside both the container and the Lume VM. It speaks the same stdin/stdout protocol regardless of runtime.

### Query Loop

```
main()
  ├── Read stdin → ContainerInput JSON
  ├── Drain pending IPC input files
  ├── Loop:
  │     ├── runQuery(prompt, sessionId, ...)
  │     │     ├── Create MessageStream (async iterable)
  │     │     ├── Push initial prompt
  │     │     ├── Start IPC poll (push follow-ups into stream)
  │     │     ├── query(SDK) with stream as prompt
  │     │     │     ├── cwd = WORKSPACE_BASE/group
  │     │     │     ├── resume = sessionId
  │     │     │     ├── systemPrompt = claude_code + global/CLAUDE.md
  │     │     │     ├── settingSources = ['project', 'user']
  │     │     │     ├── mcpServers = { nanoclaw: ipc-mcp-stdio.js }
  │     │     │     └── permissionMode = bypassPermissions
  │     │     ├── For each result message → writeOutput(stdout markers)
  │     │     └── Return { newSessionId, lastAssistantUuid }
  │     ├── Emit session-update marker
  │     ├── waitForIpcMessage() — blocks until next input or _close
  │     └── If _close → break; else → loop with new prompt
  └── Exit
```

### MCP Tools (nanoclaw server)

The agent-runner launches `ipc-mcp-stdio.js` as an MCP server via stdio. It provides these tools to the Claude SDK:

| Tool | Purpose | Authorization |
|------|---------|---------------|
| `send_message` | Send text to a chat | Same group, or any if main |
| `send_photo` | Send image to a chat | Same group, or any if main |
| `schedule_task` | Create scheduled task | Self only, or any if main |
| `list_tasks` | Read current_tasks.json | Filtered by group |
| `pause_task` / `resume_task` / `cancel_task` | Task lifecycle | Own tasks, or any if main |
| `register_group` | Register new group | Main only |

### Settings and Skills

The SDK discovers settings at `~/.claude/settings.json` (via `settingSources: ['user']`). This file is written by the host during workspace preparation:

```json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1",
    "CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD": "1",
    "CLAUDE_CODE_DISABLE_AUTO_MEMORY": "0"
  }
}
```

Skills are synced from `container/skills/*/` to `~/.claude/skills/*/` on every invocation. The SDK auto-discovers them.

## Memory Hierarchy

```
groups/global/CLAUDE.md          ← Loaded as systemPrompt.append (all groups read, main writes)
groups/{ef}/CLAUDE.md            ← Loaded as project CLAUDE.md (cwd = groups/{ef}/)
~/.claude/settings.json          ← SDK user settings (env vars, feature flags)
~/.claude/skills/                ← Agent skills (copied from container/skills/)
~/.claude/*.jsonl                ← Session transcripts (conversation history)
```

### Persona Templates

`groups/*/CLAUDE.md.default` are git-tracked templates with "Andy" as the default name. On startup, `generateClaudeMdFiles()` in `index.ts` generates the actual `CLAUDE.md` **only if it doesn't already exist**, replacing "Andy" with `ASSISTANT_NAME` from `.env`. The generated files are gitignored.

**When `.default` is updated** (e.g. after `git pull`): the existing `CLAUDE.md` is NOT automatically regenerated — it's treated as an independent instance that may have local customizations. Manually review the diff and merge changes into the deployed `CLAUDE.md`. After updating, a VM restart is required for the agent to see the new content (VirtioFS caching).

## Concurrency Model

The `GroupQueue` (`src/group-queue.ts`) manages concurrency:

- **Global limit:** `MAX_CONCURRENT_CONTAINERS` (default 5) — applies across all groups
- **Per-group:** One active agent at a time per chat JID
- **Queueing:** Tasks queue first (won't be re-discovered), then messages (will be re-discovered from DB)
- **Retry:** Exponential backoff: 5s → 10s → 20s → 40s → 80s, max 5 retries

**Lume VM caveat:** All Lume agents share a single VM with a single workspace path (`/Users/lume/workspace`). The symlink setup in `buildSshCommand()` overwrites workspace on every run. This means **concurrent Lume agents for different groups will conflict**. In practice, Lume groups should be limited to concurrency 1, or the workspace path must be made per-group.

## Database Schema

SQLite at `store/messages.db`:

| Table | Key Fields | Purpose |
|-------|-----------|---------|
| `chats` | `jid (PK)`, `name`, `last_message_time` | Chat metadata |
| `messages` | `id`, `chat_jid`, `sender`, `content`, `timestamp` | Message history |
| `registered_groups` | `jid (PK)`, `folder`, `trigger_pattern`, `runtime`, `container_config` | Group registry |
| `sessions` | `group_folder (PK)`, `session_id` | Agent session IDs |
| `scheduled_tasks` | `id (PK)`, `group_folder`, `schedule_type`, `next_run`, `status` | Task definitions |
| `task_run_logs` | `task_id`, `run_at`, `duration_ms`, `status` | Execution audit |
| `router_state` | `key (PK)`, `value` | Persistent state (timestamps, cursors) |

## Key Differences from Upstream

| Aspect | Upstream (nanoclaw) | Desktop fork (nanoclaw-desktop) |
|--------|--------------------|---------------------------------|
| Channel | WhatsApp (baileys) | Telegram (grammy) |
| Runtime | Apple Container (Linux) | Lume macOS VM (SSH + VirtioFS) |
| Topic isolation | N/A | Forum Topics → `effectiveFolder` with `~t{id}` suffix |
| Browser | Headless Chromium in container | Headed Chrome via Patchright (anti-detection) |
| Persona | Hardcoded in CLAUDE.md | Templates (`.default`) with ASSISTANT_NAME substitution |
| Group migration | N/A | Auto-migrate JID on Telegram supergroup upgrade |
| Auth env | Mounted file in container | SSH `export` from host `.env` |

## File Map

| File | Purpose | Key Functions |
|------|---------|---------------|
| `src/index.ts` | Orchestrator | `main()`, `runAgent()`, `processGroupMessages()`, `startMessageLoop()`, `generateClaudeMdFiles()` |
| `src/channels/telegram.ts` | Telegram I/O | `connect()`, `sendMessage()`, `sendPhoto()`, `onMigrateGroup` |
| `src/lume-runner.ts` | VM agent launcher | `prepareVmWorkspace()`, `buildSshCommand()`, `runLumeAgent()` |
| `src/container-runner.ts` | Container agent launcher | `buildVolumeMounts()`, `runContainerAgent()`, `writeTasksSnapshot()`, `writeGroupsSnapshot()` |
| `src/ipc.ts` | Host-side IPC processor | `startIpcWatcher()`, `processTaskIpc()` |
| `src/group-queue.ts` | Concurrency + piping | `enqueueMessageCheck()`, `sendMessage()`, `closeStdin()` |
| `src/task-scheduler.ts` | Scheduled task runner | `startSchedulerLoop()`, `runTask()` |
| `src/router.ts` | Message formatting | `formatMessages()`, `formatOutbound()`, `findChannel()` |
| `src/types.ts` | Types + path helpers | `getEffectiveFolder()`, `getBaseFolder()`, `stripTopicSuffix()` |
| `src/config.ts` | Constants | `LUME_VM_NAME`, `LUME_WORKSPACE`, `GROUPS_DIR`, `DATA_DIR` |
| `src/db.ts` | SQLite ops | All CRUD, `migrateRegisteredGroupJid()` |
| `container/agent-runner/src/index.ts` | Agent entry point | `runQuery()`, `MessageStream`, `drainIpcInput()` |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | MCP tools for agent | `send_message`, `schedule_task`, `send_photo`, etc. |
| `container/agent-runner/deploy.sh` | SCP agent-runner to VM | Bypasses VirtioFS cache |
| `container/tools/patchright-browser.mjs` | Anti-detection browser tool | Snapshot/refs, click, fill, screenshot, etc. |
| `container/tools/proxy-manager.mjs` | Per-workspace proxy IP manager | Assign/renew/list/release via Qingguo API |
| `container/tools/deploy.sh` | SCP browser tool to VM | Bypasses VirtioFS cache |

## Proxy IP Architecture

Multi-account browser automation requires each workspace to have a distinct residential IP to avoid detection. Proxies are managed per-workspace via Qingguo (青果网络) long-term dynamic residential IPs.

### Per-Workspace Proxy Config

Each workspace can optionally have a `.proxy` file at `groups/{topic}/.browser-data/.proxy`:

```json
{
  "server": "socks5://authkey:authpwd@ip:port",
  "proxyIp": "27.190.61.132",
  "area": "河北省唐山市",
  "areaCode": "130200",
  "isp": "电信",
  "taskId": "Iat3tBOj4L6U8oGo",
  "timezone": "Asia/Shanghai",
  "lang": "zh-CN",
  "deadline": "2026-03-03 21:38:38"
}
```

No `.proxy` file = no proxy = direct connection (default behavior, fully backward compatible).

### IP Lifecycle

```
ensureBrowser()
  │
  ├─ .proxy exists?
  │    ├─ No  → direct connection, no proxy
  │    └─ Yes → check deadline
  │              ├─ > 1h remaining → use current IP
  │              └─ ≤ 1h remaining or expired → call Qingguo API
  │                   ├─ extract new IP (same area + ISP)
  │                   ├─ update .proxy file
  │                   └─ launch browser with new --proxy-server
  │
  ▼
  Execute task → close browser
```

Key design points:

- **On-demand renewal**: IP is renewed at browser launch when deadline is within 1 hour, not via a background timer. This ensures the browser never starts with a stale IP.
- **Task = browser lifetime**: each task starts a fresh browser and closes it when done. No mid-task IP expiration risk (1h buffer).
- **No release API**: dynamic IPs auto-expire at deadline. `/delete` endpoint is only for static IPs.
- **Fingerprint alignment**: `.proxy` can override `timezone` and `lang` to match the IP's geography. All mainland China IPs use `Asia/Shanghai` + `zh-CN`.
- **Isolation stacks with existing model**: workspace already isolates browser profile, cookies, and fingerprint (deterministic from workspace path hash). Proxy adds the IP layer.

### Proxy Manager CLI

`container/tools/proxy-manager.mjs` — manual proxy management:

```bash
# Assign a new proxy to a workspace
QG_AUTH_KEY=xxx QG_AUTH_PWD=xxx proxy-manager assign <topic> --area 130200 --isp 电信

# List all proxy assignments
proxy-manager list

# Renew all expired proxies
QG_AUTH_KEY=xxx QG_AUTH_PWD=xxx proxy-manager renew
```

### Qingguo API

- Extract: `GET https://longterm.proxy.qg.net/get?key=AUTH_KEY&num=1&area=CODE&isp=0|1|2|3&format=json&distinct=true`
- SOCKS5 auth: username=AuthKey, password=AuthPwd
- ISP codes: 0=any, 1=电信, 2=移动, 3=联通
- Area codes: 行政区划代码 (e.g. 130200=唐山, 310100=上海)
- Full API reference: see `memory/qingguo-api.md`
