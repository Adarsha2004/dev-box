# dev-box

dev-box is a self-hosted autonomous coding agent. You connect a GitHub repository with a Personal Access Token (PAT), open a session, and send instructions in plain language. An LLM agent works on a fresh clone of the repo inside an isolated sandbox (a Docker container or an [E2B](https://e2b.dev) microVM). It can split independent work across parallel sub-agents, each in its own sandbox. Every step streams live to the browser, and when the run finishes the changes can be pushed to a `devbox/session-<id>` branch.

```
 Browser (React)  ──HTTP──▶  Controller API (Express)  ──▶  Postgres (Prisma 8)
       ▲                           │
       └──────WebSocket────────────┤
                                   ▼
                          Brain (agent tree)
                     ┌─────────────┼──────────────┐
                     ▼             ▼              ▼
               primary agent   child agent    child agent      ◀── Harness (LLM loop + tools)
                     │             │              │
               session sandbox  pooled sandbox  pooled sandbox  ◀── Sandbox layer (Docker | E2B)
                (git clone)     (git clone)     (git clone)
```

---

## Contents

- [Features](#features)
- [Repository layout](#repository-layout)
- [Architecture](#architecture)
  - [Layers at a glance](#layers-at-a-glance)
  - [Request lifecycle](#request-lifecycle)
  - [Controller (HTTP + WebSocket)](#controller-http--websocket)
  - [Brain: the agent tree](#brain-the-agent-tree)
  - [Harness: the agent loop](#harness-the-agent-loop)
  - [Sandbox layer](#sandbox-layer)
  - [Sandbox pool](#sandbox-pool)
  - [Lifecycle and garbage collection (cron)](#lifecycle-and-garbage-collection-cron)
  - [Data model](#data-model)
  - [Secrets handling](#secrets-handling)
  - [Streaming event protocol](#streaming-event-protocol)
  - [Frontend](#frontend)
  - [Extension points](#extension-points)
- [Getting started](#getting-started)
- [Configuration](#configuration)
- [API reference](#api-reference)
- [Scripts](#scripts)
- [Benchmarking](#benchmarking)
- [Known limitations](#known-limitations)

---

## Features

- **Connect any GitHub repo** with a fine-grained or classic PAT. Access is checked against the GitHub API before the repo is saved.
- **One sandbox per session.** Each session gets a long-lived sandbox with the repo cloned into `/workspace`. It is reused across messages and recreated automatically if it was reclaimed.
- **Parallel sub-agents.** The primary agent can call `spawn_agent` to run independent subtasks in separate sandboxes. It collects their results as unified diffs and applies them with `git apply`.
- **Live streaming.** Token deltas, tool calls, tool results and per-turn usage from every agent are pushed over WebSocket.
- **Optional push.** At the end of a run, changes are committed and pushed to `devbox/session-<id>`.
- **Pluggable sandboxes:** Docker (local) or E2B (hosted microVMs), selected with one environment variable.
- **Pluggable LLM providers:** any OpenAI-compatible endpoint. GLM (z.ai), Groq and Anthropic are pre-wired.
- **Warm pool and garbage collection.** Child sandboxes are pre-created so spawning is fast, and idle, orphaned and unclaimed sandboxes are reaped every minute.

---

## Repository layout

```
dev-box/
├── backend/                     Bun + TypeScript
│   ├── controller/              HTTP API, WebSocket hub, cron, GitHub + crypto helpers
│   │   ├── index.ts             Express app, route table, starts cron + WS
│   │   ├── repos.ts             register / list / get / delete / verify repos
│   │   ├── sessions.ts          create session, messages, runBrain(), pushBranch()
│   │   ├── github.ts            repo-ref parsing, access checks, repo listing
│   │   ├── crypto.ts            AES-256-GCM encryption for stored PATs
│   │   ├── ws.ts                per-session WebSocket rooms + publish()
│   │   ├── cron.ts              idle / orphan / pool sandbox sweeper
│   │   └── types.ts             zod schemas + shared types
│   ├── brain/                   multi-agent orchestration
│   │   ├── run.ts               runTree(): primary agent + child agents
│   │   └── spawn.ts             spawn_agent / wait_agents tools, system prompts, diff extraction
│   ├── harness/                 provider-agnostic single-agent loop
│   │   ├── agents/loop.ts       runAgent(): stream → tool calls → tool results → repeat
│   │   ├── providers/           OpenAI-compatible streaming adapter + provider registry
│   │   ├── tools/               bash + read tools (local and sandbox-backed variants)
│   │   ├── types.ts             Message / Tool / Provider types
│   │   └── index.ts             standalone CLI (runs the agent on the local machine)
│   ├── sandbox/                 swappable execution environments
│   │   ├── types.ts             Sandbox + SandboxProvider interfaces
│   │   ├── index.ts             driver registry (SANDBOX_DRIVER)
│   │   ├── docker.ts            Docker CLI driver
│   │   ├── Dockerfile           sandbox image (node:22-bookworm-slim + git)
│   │   ├── e2b.ts               E2B driver
│   │   ├── e2b-template.ts      E2B template definition / builder
│   │   └── pool.ts              warm pool for child sandboxes
│   ├── DB/                      Prisma 8 contract, generated types, migrations, client
│   ├── bench/sandbox-bench.ts   startup + concurrency benchmark for sandbox drivers
│   └── prisma.config.ts
└── frontend/                    Bun + React 19 + Tailwind 4 single-page UI
    └── src/                     App.tsx (UI), index.ts (Bun dev server on :3001)
```

---

## Architecture

### Layers at a glance

The backend is four layers. Each one only depends on the layers below it, through a small interface:

| Layer | Responsibility | Depends on | Key interface |
|---|---|---|---|
| **Controller** | HTTP API, persistence, auth to GitHub, WebSocket fan-out, sandbox lifecycle | Brain, Sandbox, DB | Express routes, `publish(sessionId, event)` |
| **Brain** | Turns one user request into a tree of agents, with a primary and parallel children | Harness, Sandbox (interface only) | `runTree(opts) → { summary }` |
| **Harness** | One LLM agent loop: stream, run tools, feed results back | Provider, Tools | `runAgent(opts)`, `Provider.stream()`, `Tool.execute()` |
| **Sandbox** | Isolated, cloned workspaces that run shell commands | Docker CLI / E2B SDK | `SandboxProvider.create/get/list`, `Sandbox.exec/destroy` |

The design keeps the **harness unaware of sandboxes**. Tools take an `ExecFn` (`harness/tools/exec-tools.ts`), so the same `bash` and `read` tools can run on the local machine (CLI mode), in a Docker container, or in an E2B VM, and only the exec target changes. In the same way, the **brain does not create sandboxes itself**. It receives an `acquireChild()` callback, which the controller wires to the warm pool.

### Request lifecycle

What happens when a user sends "add input validation to the signup form and write tests":

```
Browser                 Controller                         Brain / Harness                 Sandbox
  │ POST /api/repos ───────▶ parse ref, GET github /repos/:o/:n
  │                         encrypt PAT, upsert Repo row
  │ ◀──── { repo }
  │
  │ POST /repos/:id/sessions ▶ find active Session for repo
  │                         ├─ sandboxId alive? → reuse
  │                         └─ else decrypt PAT ─────────────────────────────────▶ create(): run container,
  │                                                                                git clone → /workspace
  │ ◀──── { sessionId, sandboxId, reused }
  │
  │ WS connect /ws?sessionId=N ─▶ join room N
  │
  │ POST /messages {content, push} ▶ store Message(user), bump lastMessageAt
  │ ◀──── 202 { streaming: true }   runBrain() in background
  │                                   pool.warm(repo)  ───────────────────────────▶ pre-clone children
  │                                   buildPrompt(history + new msg)
  │                                   runTree(primary = session sandbox) ─▶ runAgent(primary)
  │ ◀═══ WS: text / tool_start / tool_end / turn_end  (agentId "primary") ◀══╡ bash/read ──▶ exec in sandbox
  │                                                                          │ spawn_agent ─▶ pool.acquire()
  │ ◀═══ WS: events tagged agentId "a1", "a2" …                              │   runAgent(child) in its sandbox
  │                                                                          │ wait_agents ◀─ {summary, git diff}
  │                                                                          │ bash: git apply <diff>
  │                                                                          ╘ final text = summary
  │ ◀═══ WS: { type: "done", summary }
  │                                   store Message(assistant, summary)
  │                                   if push: git checkout -B devbox/session-N, commit, push
  │ ◀═══ WS: pushing → pushed { branch } | push_failed { error }
```

Three things to note:

1. **The HTTP call returns right away (`202`).** The run happens in the background, and the browser follows progress only over the WebSocket. Errors that escape the brain are published as `{ type: "error" }`.
2. **Conversation memory is rebuilt from the database on every message.** `buildPrompt()` flattens the session's earlier messages into a transcript and adds the new instruction. The working tree in the session sandbox carries over between messages, so the agent sees both the earlier conversation and its own earlier edits.
3. **The primary agent runs in the session's own sandbox** (`destroyPrimary: false`), so its changes stay after the run. Children always run in throwaway sandboxes.

### Controller (HTTP + WebSocket)

`controller/index.ts` starts three things in one process:

- **Express API** on `PORT` (default `3000`). It handles JSON bodies and CORS, and validates requests with zod (`controller/types.ts`).
- **WebSocket server** on `WS_PORT` (default `8080`), path `/ws`.
- **Cron sweeper**, which runs once at boot and then every 60 s.

**Repos** (`repos.ts`, `github.ts`):
- `parseRepoRef` accepts `owner/name`, `https://github.com/owner/name(.git)` and `git@github.com:owner/name(.git)`.
- `checkRepoAccess` calls `GET /repos/:owner/:name` with the PAT and maps GitHub status codes to useful errors (401 invalid token, 404 missing repo or no access, 403 forbidden or rate-limited). It rejects tokens without `pull` permission.
- Repos are upserted by `fullName`. The PAT is stored encrypted, together with a 4-character preview.
- Every read uses a `SAFE_FIELDS` projection, so `patEncrypted` never leaves the database through the API.
- `verifyRepo` decrypts the PAT, checks access again, and updates `valid` and `lastCheckedAt`.

**Sessions** (`sessions.ts`):
- **A repo has at most one active session, and it is reused.** `createSession` looks up the active session for the repo. If its sandbox still exists, it is returned (`reused: true`). Otherwise a new sandbox is created and attached to the existing row, or to a new row if none exists. This is the "self-healing" path after the cron has reclaimed an idle sandbox.
- `createMessage` stores the message. If it is a `user` message and the session has a sandbox, it starts `runBrain()` without waiting for it.
- `pushBranch` runs `git checkout -B devbox/session-<id>`, `git add -A`, then commits with the first non-empty line of the summary (72 characters at most) as the message, then pushes. If there are no staged changes, it reports "nothing to push".

**WebSocket hub** (`ws.ts`): clients connect to `ws://host:8080/ws?sessionId=N`, and each connection joins an in-memory "room" for that session. `publish(sessionId, event)` serializes the event once and sends it to every open socket in the room. The hub only fans out live events and does not replay them. History comes from `GET …/messages`.

### Brain: the agent tree

`brain/run.ts` and `brain/spawn.ts` turn a single-agent loop into a **two-level tree of agents**.

```
                        ┌────────────────────────────────────────┐
                        │ primary  (depth 0, session sandbox)    │
                        │ tools: read, bash, spawn_agent,        │
                        │        wait_agents                     │
                        └───────┬───────────────┬────────────────┘
                     spawn_agent│               │spawn_agent
                                ▼               ▼
                   ┌──────────────────┐  ┌──────────────────┐
                   │ a1 (depth 1)     │  │ a2 (depth 1)     │   … up to maxChildren
                   │ pooled sandbox   │  │ pooled sandbox   │
                   │ tools: read,bash │  │ tools: read,bash │   (no spawn at maxDepth)
                   └────────┬─────────┘  └────────┬─────────┘
                            │ git add -A; git diff --cached
                            ▼                     ▼
                     { id, ok, summary, diff }  ─────▶ wait_agents result ─▶ primary runs `git apply`
```

**`runTree(opts)`**:
- Builds a shared context: provider, model, `acquireChild`, `maxDepth` (default 1), `maxChildren` (default 8, set by `BRAIN_MAX_CHILDREN`), the `onEvent` sink, and a running child counter.
- Runs the primary agent with `PRIMARY_SYSTEM`. If no `primary` sandbox is passed in, it gets one from `acquireChild()` and destroys it at the end.
- Every event is tagged `{ agentId, depth }` before it is forwarded, so the UI can draw one trace per agent.
- The **final summary is the concatenation of every text delta** the primary agent produced.

**`toolsFor(ctx, sandbox, depth, idPrefix)`** gives each agent `read` and `bash` bound to its own sandbox through `makeTools(sandbox.exec)`. It adds `spawn_agent` and `wait_agents` only while `depth + 1 <= maxDepth`. With the default `maxDepth = 1`, children cannot spawn their own children. Agent ids are hierarchical (`a1`, `a2`, …, and would be `a1.1` if depth were raised).

**`spawn_agent`** returns immediately. It checks the global child limit, increments the counter, starts `runChild()` as an unawaited promise, and keeps that promise in a per-agent `pending` map. This is how several children run at the same time while the primary agent keeps working.

**`wait_agents`** waits for the given ids, or for all pending ones, and formats each result as:

```
--- agent a1 done
summary: <child's final text>
<diff>
<unified diff, truncated at 8000 chars>
</diff>
```

**`runChild()`** gets a sandbox, runs the agent with `CHILD_SYSTEM`, and then **extracts its work as a diff** (`git add -A && git diff --cached`). It always destroys the sandbox in `finally`. Failures, including failing to get a sandbox, become `{ ok: false, summary: <error> }` results and are never thrown, so one bad child cannot crash the tree.

**Why diffs?** Child sandboxes are separate clones. The only way their work reaches the session workspace is through a patch that the primary agent applies. This keeps the session sandbox under one writer, avoids filesystem races between parallel agents, and lets the primary agent review or reject a child's changes before applying them.

**System prompts** (`spawn.ts`):
- `PRIMARY_SYSTEM` tells the agent to explore before editing, keep diffs minimal, run tests, build or lint and iterate until they pass, never commit or push, spawn only for independent subtasks with fully self-contained prompts, and apply child diffs with `git apply` instead of rewriting files. It ends with a short report.
- `CHILD_SYSTEM` tells the child to do exactly its task, check the result, and reply with a short summary.

### Harness: the agent loop

The harness (`harness/`) is a small, provider-agnostic agent runtime with no knowledge of sandboxes, sessions or the brain.

**Message model** (`harness/types.ts`), similar to the Anthropic and OpenAI shapes but independent of both:

```ts
UserMessage       { role: "user", content: string }
AssistantMessage  { role: "assistant", content: (TextBlock | ToolCallBlock)[], usage, stopReason }
ToolResultMessage { role: "toolResult", toolCallId, toolName, content, isError }
StopReason        "stop" | "length" | "toolUse"
```

**`runAgent()`** (`harness/agents/loop.ts`):

```
for turn in 1..maxTurns (default 20):
    stream provider → emit {text} for each delta → collect final AssistantMessage
    append it, emit {turn_end}
    if stopReason != "toolUse": return
    for each toolCall (sequential):
        emit {tool_start}
        result = tool.execute(args)   // exceptions → "Error …", isError = true
        emit {tool_end}
        append ToolResultMessage
throw "stopped after maxTurns"
```

Tool calls within a turn run **one after another**. Parallelism comes from the brain, where `spawn_agent` returns immediately. Unknown tools and tool exceptions are returned to the model as error results instead of failing the run.

**Providers** (`harness/providers/`): the only adapter is `createOpenAICompat(name, baseURL, apiKey, defaultModel)`, built on the `openai` SDK. It:
- converts harness messages to Chat Completions format (assistant text and `tool_calls`, and `role: "tool"` results),
- streams with `include_usage`, and yields `text_delta` events,
- rebuilds streamed tool calls by `index`, concatenating their argument fragments, then parses the JSON,
- sets `stopReason = "toolUse"` if any tool call appears, even when the provider reports `finish_reason` differently.

Registered providers (`harness/providers/index.ts`):

| Key | Endpoint | Default model | Env var |
|---|---|---|---|
| `glm` *(brain default)* | `https://api.z.ai/api/coding/paas/v4` | `glm-5.3` | `ZAI_API_KEY` |
| `groq-openai` *(CLI default)* | `https://api.groq.com/openai/v1` | `qwen/qwen3.8-27b` | `GROQ_API_KEY` |
| `anthropic-openai` | `https://api.anthropic.com/v1/` | `claude-sonnet-5` | `ANTHROPIC_API_KEY` |

**Tools** (`harness/tools/`):
- `read { path }` returns a file's contents.
- `bash { command, timeout? = 30s }` returns combined stdout and stderr plus `[exit code: N]`.
- Output is cut with `truncateTail`, which keeps the **last** 2000 lines or 50 KB, because errors and results are usually at the end, and adds a note saying what was cut.
- `makeTools(exec)` reuses the same tool specs with `execute` bound to a sandbox. In that mode `read` becomes `cat <path>` inside the sandbox.

**Standalone CLI** (`harness/index.ts`): runs one agent with the **local** `bash` and `read` tools in the current directory, with no sandbox. This is useful for testing providers:

```bash
bun harness/index.ts -p "summarise this repo" --provider glm
```

### Sandbox layer

The sandbox layer is a small interface with interchangeable drivers (`sandbox/types.ts`):

```ts
interface SandboxProvider {
  name: string;
  create({ fullName, pat, labels }): Promise<Sandbox>;  // provision + git clone into /workspace
  get(id): Promise<Sandbox | null>;                     // reattach by id (stateless)
  list(): Promise<SandboxInfo[]>;                       // all devbox-managed sandboxes
}
interface Sandbox {
  id; provider; fullName;
  exec(command, { cwd?, env?, timeout? }): Promise<{ stdout, stderr, exitCode, timedOut }>;
  destroy(): Promise<void>;
}
```

The driver is chosen with `SANDBOX_DRIVER` (`docker` by default, or `e2b`) in `sandbox/index.ts`.

**Both drivers are stateless.** All bookkeeping lives on the sandbox itself, as labels in Docker or metadata in E2B: `devbox.managed=true`, `devbox.repo`, `devbox.createdAt`, `devbox.session`, and `devbox.child` for child sandboxes. `get(id)` rebuilds a handle from that metadata, so a backend restart, or several backend instances, see the same sandboxes. The database only stores `Session.sandboxId`.

**Docker driver** (`sandbox/docker.ts`):
- Calls the `docker` CLI directly, with no Docker SDK. Each call has a timeout and output is capped at 50 KB.
- On first use, `ensureImage()` builds `devbox-sandbox:latest` from `sandbox/Dockerfile` (`node:22-bookworm-slim` with git, curl and procps). Concurrent callers share one build promise.
- A container is `docker run -d --name devbox-sb-<12 hex> -w /workspace … sleep infinity`, and `exec` is `docker exec [-w] [-e K=V] <name> bash -c <cmd>`.

**E2B driver** (`sandbox/e2b.ts`, `sandbox/e2b-template.ts`):
- Uses an E2B template with the same base image and tools as the Dockerfile. Build it once with `bun run e2b:template`, which uses `E2B_CPUS` and `E2B_MEMORY_MB`. Because E2B boots from a snapshot, startup takes well under a second.
- E2B kills a sandbox when its timeout runs out. The driver extends the timeout to `E2B_TIMEOUT_MINUTES` at most once a minute while `exec` is called, so the timeout acts as a maximum idle time.
- A non-zero exit (`CommandExitError`) is turned into a normal `ExecResult`, the same as with Docker, so agents see the same behavior on both drivers.

**Clone process (both drivers):** after the sandbox starts, `create()` clones `https://github.com/<fullName>.git` into `/workspace`, with up to 180 s allowed. If the clone fails, the sandbox is destroyed and the error is raised.

### Sandbox pool

`sandbox/pool.ts` removes most of the start-up delay (container start plus `git clone`) from `spawn_agent`.

- **`warm(opts)`** runs in the background and fills the idle list for a repo up to `POOL_MIN` (default 2). Only one fill runs per repo at a time. `runBrain()` calls it at the start of every run, so children are usually warm by the time the primary agent decides to spawn.
- **`acquire(opts)`** takes a warm sandbox if there is one, or creates one if not, and triggers a refill in the background either way. It returns a **leased wrapper** whose `destroy()` also releases the lease.
- **`reap()`** destroys idle pooled sandboxes older than `POOL_IDLE_TTL_MINUTES` (default 15). The cron calls it.
- **`knows(id)`** reports whether the pool still owns a sandbox, either idle or leased, so the cron's orphan sweep leaves it alone.

The pool is in-memory and per-process. Pooled sandboxes still carry `devbox.child=true` labels, so if the process dies they are eventually cleaned up as orphans.

### Lifecycle and garbage collection (cron)

`controller/cron.ts` runs `sweepIdleSandboxes()` at boot and then every 60 s. A flag prevents two sweeps from overlapping. Each sweep has three passes:

| Pass | Targets | Rule | Effect |
|---|---|---|---|
| **Idle sessions** | Primary sandboxes of `active` sessions | `lastMessageAt` older than `IDLE_TTL_MINUTES` (30) | Destroy the sandbox and set `sandboxId = null`. The session stays active and gets a new sandbox the next time it is opened. |
| **Pool** | Unclaimed warm sandboxes | Idle longer than `POOL_IDLE_TTL_MINUTES` (15) | `pool.reap()` |
| **Orphans** | Any `devbox.child=true` sandbox | Older than `ORPHAN_TTL_MINUTES` (15) and not known to the pool | Destroy it. These come from crashed or interrupted runs. |

Sandbox lifecycle summary:

```
session sandbox:  create (POST /sessions) ──▶ reused across messages ──▶ idle 30m ─▶ destroyed by cron
                                                    ▲                                   │
                                                    └──── recreated on next POST /sessions ◀┘

child sandbox:    pool.warm ─▶ idle ─(acquire)─▶ leased ─▶ agent runs ─▶ diff extracted ─▶ destroyed
                                  └─ 15m unclaimed ─▶ reaped        └─ crashed run ─▶ orphan sweep
```

### Data model

The schema is defined in `backend/DB/contract.prisma` and uses **Prisma 8** (`@prisma/orm-postgres`) with a JSON contract (`contract.json`) and generated types (`contract.d.ts`). Migrations and snapshots live in `DB/migrations/`.

```
Repo 1 ──── * Session 1 ──── * Message
```

| Model | Fields | Notes |
|---|---|---|
| `Repo` | `owner`, `name`, `fullName` (unique), `defaultBranch`, `patEncrypted`, `patPreview`, `valid`, `lastCheckedAt` | One row per GitHub repo. The PAT is encrypted at rest. |
| `Session` | `repoId`, `status` (`"active"`), `sandboxId?`, `lastMessageAt` | `sandboxId` is null while the sandbox has been reclaimed. `lastMessageAt` drives idle expiry. |
| `Message` | `sessionId`, `role` (`user`/`assistant`), `content` | Chat history. The assistant message is the brain's final summary, not the full trace. |
| `User`, `Post` | | Leftovers from the starter scaffold. Not used by the app. |

The database client is in `DB/db.ts` (`db.orm.public.<Model>.where(...).first()/all()/update()/create()`).

### Secrets handling

- **At rest:** PATs are encrypted with **AES-256-GCM** (`@noble/ciphers`) using `ENCRYPTION_KEY`, a 32-byte hex string. The stored value is `base64(nonce[12] || ciphertext+tag)`. The process refuses to start without the key. If the key is rotated, existing PATs can no longer be decrypted, and the API reports this explicitly.
- **In API responses:** only `patPreview`, the last 4 characters, is ever returned.
- **Inside sandboxes:** the token is **never in argv or `.git/config`**. Clone and push use an inline credential helper that reads `$SB_PAT`, an environment variable set only for that one `exec`:
  ```
  git -c credential.helper='!f() { echo username=x-access-token; echo password=$SB_PAT; }; f' clone …
  ```
  As a result, commands the agent runs later, such as `git remote -v` or `cat .git/config`, cannot see the token.

### Streaming event protocol

Every message on `ws://…/ws?sessionId=N` is a JSON object that includes `sessionId`:

| `type` | Extra fields | Emitted when |
|---|---|---|
| `connected` | | Socket joined the room |
| `text` | `agentId`, `depth`, `delta` | Token delta from any agent |
| `tool_start` | `agentId`, `depth`, `call: { id, name, arguments }` | Before a tool runs |
| `tool_end` | `agentId`, `depth`, `call`, `result`, `isError` | After a tool returns |
| `turn_end` | `agentId`, `depth`, `message: { usage, stopReason, … }` | End of each LLM turn |
| `message` | `agentId`, `depth`, `message` | Any message appended to an agent's history |
| `done` | `summary` | Brain finished. The summary is also saved as an assistant `Message`. |
| `pushing` / `pushed` / `push_failed` | `branch` / `error` | Optional branch push |
| `error` | `error` | Brain run threw an error |

`agentId` is `"primary"` for the root agent and `a1`, `a2`, … for children. Group events by it to draw one trace per agent.

### Frontend

`frontend/` is a Bun-served React 19 and Tailwind 4 single-page app (`src/App.tsx`), served on `:3001` by `src/index.ts` with HMR:

1. Connect form (repo and PAT): `POST /api/repos`, then `POST /api/repos/:id/sessions`.
2. Opens the WebSocket for the session and reconnects if it drops.
3. Chat input with a **"push changes"** toggle, which sends `push: true`.
4. Live trace panel with one card per `agentId`, showing streamed text, tool calls with arguments and results, and turn counts.

The backend URLs default to `http://localhost:3000` and `ws://localhost:8080` and can be changed with `API_URL` and `WS_URL`.

### Extension points

| To add… | Do this |
|---|---|
| A new sandbox backend (Firecracker, Modal, local dir…) | Implement `SandboxProvider` and `Sandbox` from `sandbox/types.ts` and register it in `sandbox/index.ts`. Nothing else changes. |
| A new LLM provider | Add an entry in `harness/providers/index.ts`. Any OpenAI-compatible API works through `createOpenAICompat`. For a native API, implement `Provider.stream()`. |
| A new agent tool | Write a `Tool` (`{ name, description, parameters, execute }`) and add it in `makeTools()` (sandbox) or `brain/run.ts → toolsFor()`. |
| Deeper agent trees | Pass `maxDepth > 1` to `runTree()`. Children then also receive `spawn_agent` and `wait_agents`. |

---

## Getting started

### Prerequisites

- [Bun](https://bun.sh) ≥ 1.2
- PostgreSQL
- **Either** Docker (for `SANDBOX_DRIVER=docker`) **or** an E2B API key (for `SANDBOX_DRIVER=e2b`)
- An API key for at least one LLM provider
- A GitHub PAT with **Contents: read** (and **Contents: write** if you want to push branches) for the target repo

### Backend

```bash
cd backend
bun install
```

Create `backend/.env` (see [Configuration](#configuration)), then generate the encryption key:

```bash
openssl rand -hex 32
```

Apply the database contract and migrations with the Prisma 8 CLI (configured in `prisma.config.ts`). If you change `DB/contract.prisma`, regenerate the contract:

```bash
bun run contract:emit
```

If you use E2B, build the template once:

```bash
bun run e2b:template
```

Start the API, WebSocket server and cron:

```bash
bun run api
```

With Docker, the sandbox image builds automatically on first use.

### Frontend

```bash
cd frontend
bun install
bun dev
```

Open http://localhost:3001.

---

## Configuration

All variables go in `backend/.env`.

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | *(required)* | Postgres connection string |
| `ENCRYPTION_KEY` | *(required)* | 64-char hex (32 bytes) for PAT encryption |
| `PORT` | `3000` | HTTP API port |
| `WS_PORT` | `8080` | WebSocket port |
| `SANDBOX_DRIVER` | `docker` | `docker` or `e2b` |
| `BRAIN_PROVIDER` | `glm` | Provider key used by the brain |
| `BRAIN_MAX_CHILDREN` | `8` | Max sub-agents per run |
| `ZAI_API_KEY` / `GROQ_API_KEY` / `ANTHROPIC_API_KEY` | | Provider credentials |
| `IDLE_TTL_MINUTES` | `30` | Idle time before a session's sandbox is reclaimed |
| `ORPHAN_TTL_MINUTES` | `15` | Age after which unowned child sandboxes are destroyed |
| `POOL_MIN` | `2` | Warm child sandboxes kept per repo |
| `POOL_IDLE_TTL_MINUTES` | `15` | Time an unclaimed pooled sandbox lives |
| `E2B_API_KEY` | | E2B credentials (read by the E2B SDK) |
| `E2B_TEMPLATE` | `devbox-sandbox` | E2B template name |
| `E2B_TIMEOUT_MINUTES` | `60` | E2B sandbox idle lifetime |
| `E2B_CPUS` / `E2B_MEMORY_MB` | `2` / `2048` | Template resources (build time) |

---

## API reference

Base URL: `http://localhost:3000`

| Method | Path | Body | Response |
|---|---|---|---|
| `GET` | `/health` | | `{ status: "ok" }` |
| `POST` | `/api/repos` | `{ repo, pat }` | `201`/`200 { repo }`. Validates access and upserts. |
| `POST` | `/api/repos/accessible` | `{ pat }` | `{ count, likelyMore, repos[] }`. First 100 repos the PAT can read. |
| `GET` | `/api/repos/:id` | | `{ repo }` |
| `DELETE` | `/api/repos/:id` | | `{ deleted: fullName }` |
| `POST` | `/api/repos/:id/verify` | | `{ valid, permissions? , error? }` |
| `POST` | `/api/repos/:repoId/sessions` | | `{ sessionId, sandboxId, reused }` |
| `GET` | `/api/repos/:repoId/sessions/:sessionId/messages` | | `{ messages[] }` |
| `POST` | `/api/repos/:repoId/sessions/:sessionId/messages` | `{ content, role? = "user", push? = false }` | `202 { message, streaming: true }` for user messages, otherwise `201 { message }` |

Example:

```bash
curl -X POST localhost:3000/api/repos -H 'content-type: application/json' \
  -d '{"repo":"octocat/Hello-World","pat":"github_pat_..."}'
```

---

## Scripts

Run from `backend/`:

| Script | Command | Description |
|---|---|---|
| `bun run api` | `bun controller/index.ts` | API, WebSocket server and cron |
| `bun run start` | `bun harness/index.ts` | Standalone local agent CLI (`-p`, `--provider`, `--model`) |
| `bun run contract:emit` | `prisma contract emit` | Regenerate the DB contract |
| `bun run e2b:template` | `bun sandbox/e2b-template.ts` | Build the E2B template |
| `bun run bench` | `bun bench/sandbox-bench.ts` | Sandbox benchmark |

---

## Benchmarking

`bench/sandbox-bench.ts` measures the sandbox infrastructure only, with no LLM calls:

```bash
SANDBOX_DRIVER=docker bun run bench octocat/Hello-World 10,25,50,100
```

1. **Startup:** p50, p95, min and max for a cold `create()` (provision plus clone) compared with a warm `pool.acquire()`.
2. **Concurrency:** for each N, it creates N sandboxes at once, runs an agent-like workload in all of them (`ls`, `cat`, `grep`, write, `git diff`), and reports success counts and wall times. It stops at the first level that does not fully succeed.

It cleans up all sandboxes for the benchmark repo before and after the run.

---

## Known limitations

- **No authentication** on the API or WebSocket. Anyone who can reach the ports can use stored repos. Run it locally or behind an authenticating proxy.
- **Single-process state.** WebSocket rooms and the sandbox pool live in memory. Sandboxes are stateless and shared across instances, but live events are only delivered by the process running the brain.
- **No cancellation.** A run continues until the agent stops or reaches `maxTurns` (20 per agent).
- **Child diffs are truncated** at 8000 characters in `wait_agents` output. Very large child changes may need to be re-done by the primary agent.
- Docker sandboxes have no CPU, memory or network limits by default. Add `--cpus`, `--memory` or `--network` in `docker.ts` if you need them.
- `User` and `Post` models are unused scaffold.
