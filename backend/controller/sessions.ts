import type { Request, Response } from "express";
import { db } from "../DB/db";
import { runTree } from "../brain/run";
import { getProvider } from "../harness/providers";
import { getSandboxProvider } from "../sandbox";
import type { Sandbox } from "../sandbox";
import { pool } from "../sandbox/pool";
import { decryptSecret } from "./crypto";
import { createMessageSchema } from "./types";
import { publish } from "./ws";

function parseId(v: unknown): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// loads the session and verifies it belongs to the repo in the URL
async function findSession(req: Request) {
  const repoId = parseId(req.params.repoId);
  const sessionId = parseId(req.params.sessionId);
  if (!repoId || !sessionId) return null;
  return (await db.orm.public.Session.where({ id: sessionId, repoId }).first()) ?? null;
}

// POST /api/repos/:repoId/sessions — reuse the primary sandbox if alive, else create
export async function createSession(req: Request, res: Response) {
  const repoId = parseId(req.params.repoId);
  if (!repoId) return res.status(400).json({ error: "invalid repoId" });

  const repo = await db.orm.public.Repo.where({ id: repoId }).first();
  if (!repo) return res.status(404).json({ error: "repo not found" });

  const session = (await db.orm.public.Session.where({ repoId, status: "active" }).first()) ?? null;

  if (session?.sandboxId) {
    const sandbox = await getSandboxProvider().get(session.sandboxId);
    if (sandbox) return res.json({ sessionId: session.id, sandboxId: sandbox.id, reused: true });
  }

  let pat: string;
  try {
    pat = decryptSecret(repo.patEncrypted);
  } catch {
    return res.status(500).json({ error: "stored PAT could not be decrypted (key changed?)" });
  }

  const row = session ?? (await db.orm.public.Session.create({ repoId }));

  try {
    const sandbox = await getSandboxProvider().create({
      fullName: repo.fullName,
      pat,
      labels: { "devbox.session": String(row.id) },
    });
    await db.orm.public.Session.where({ id: row.id }).update({ sandboxId: sandbox.id, lastMessageAt: new Date() });
    res.status(session ? 200 : 201).json({ sessionId: row.id, sandboxId: sandbox.id, reused: false });
  } catch (e) {
    res.status(502).json({ error: e instanceof Error ? e.message : String(e) });
  }
}

// GET /api/repos/:repoId/sessions/:sessionId/messages
export async function listMessages(req: Request, res: Response) {
  const session = await findSession(req);
  if (!session) return res.status(404).json({ error: "session not found" });

  const messages = await db.orm.public.Message.where({ sessionId: session.id }).orderBy((m) => m.id.asc()).all();
  res.json({ messages });
}

// commit the sandbox working tree and push it as a session branch.
// token goes through a credential helper via env — never in argv or .git/config
async function pushBranch(sessionId: number, sandbox: Sandbox, pat: string, summary: string): Promise<string> {
  const branch = `devbox/session-${sessionId}`;
  const msg = (summary.split("\n").find((l) => l.trim()) ?? "dev-box changes").slice(0, 72);

  const staged = await sandbox.exec(`git checkout -B ${branch} && git add -A && git diff --cached --quiet`);
  if (staged.exitCode === 0) throw new Error("nothing to push — no changes in the working tree");

  const pushed = await sandbox.exec(
    `git -c user.name=dev-box -c user.email=devbox@localhost commit -m ${JSON.stringify(msg)} && ` +
      `git -c credential.helper='!f() { echo username=x-access-token; echo password=$SB_PAT; }; f' push -u origin ${branch}`,
    { timeout: 120, env: pat ? { SB_PAT: pat } : undefined },
  );
  if (pushed.exitCode !== 0) throw new Error(`push failed: ${pushed.stderr || pushed.stdout}`);
  return branch;
}

// turn session history + the new message into one prompt for the brain
async function buildPrompt(sessionId: number, content: string): Promise<string> {
  const messages = await db.orm.public.Message.where({ sessionId }).orderBy((m) => m.id.asc()).all();
  const transcript = messages
    .slice(0, -1) // drop the message we just stored — it becomes the instruction below
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n\n");

  return transcript
    ? `Conversation so far:\n${transcript}\n\n---\nNew user message (do the work for this one):\n${content}`
    : content;
}

// user message → brain decides: answer itself in the primary sandbox, or fan out children.
// every step streams over WS; the summary is persisted, and optionally pushed as a branch
async function runBrain(sessionId: number, repoId: number, sandboxId: string, content: string, push: boolean) {
  const repo = (await db.orm.public.Repo.where({ id: repoId }).first())!;
  const sandbox = await getSandboxProvider().get(sandboxId);
  if (!sandbox) throw new Error(`session sandbox ${sandboxId} is gone`);

  let pat = "";
  try {
    pat = decryptSecret(repo.patEncrypted);
  } catch {
    pat = "";
  }

  // children are fresh containers of the same repo — keep them warm
  const createOpts = {
    fullName: repo.fullName,
    pat,
    labels: { "devbox.session": String(sessionId), "devbox.child": "true" },
  };
  pool.warm(createOpts);

  const provider = getProvider(process.env.BRAIN_PROVIDER ?? "glm");
  const res = await runTree({
    provider,
    model: provider.defaultModel,
    prompt: await buildPrompt(sessionId, content),
    primary: sandbox,
    destroyPrimary: false,
    acquireChild: () => pool.acquire(createOpts),
    maxChildren: Number(process.env.BRAIN_MAX_CHILDREN ?? 8),
    onEvent: (e) => publish(sessionId, { sessionId, ...e }),
  });

  publish(sessionId, { sessionId, type: "done", summary: res.summary });
  await db.orm.public.Message.create({ sessionId, role: "assistant", content: res.summary });
  await db.orm.public.Session.where({ id: sessionId }).update({ lastMessageAt: new Date() });

  if (push) {
    publish(sessionId, { sessionId, type: "pushing" });
    try {
      const branch = await pushBranch(sessionId, sandbox, pat, res.summary);
      publish(sessionId, { sessionId, type: "pushed", branch });
    } catch (e) {
      publish(sessionId, { sessionId, type: "push_failed", error: e instanceof Error ? e.message : String(e) });
    }
  }
}

// POST /api/repos/:repoId/sessions/:sessionId/messages
export async function createMessage(req: Request, res: Response) {
  const result = createMessageSchema.safeParse(req.body);

  if (!result.success) {
    return res.status(400).json({ error: "invalid message" });
  }

  const session = await findSession(req);
  if (!session) return res.status(404).json({ error: "session not found" });

  const message = await db.orm.public.Message.create({
    sessionId: session.id,
    role: result.data.role,
    content: result.data.content,
  });
  await db.orm.public.Session.where({ id: session.id }).update({ lastMessageAt: new Date() });

  if (result.data.role === "user" && session.sandboxId) {
    runBrain(session.id, session.repoId, session.sandboxId, result.data.content, result.data.push).catch((e) =>
      publish(session.id, { sessionId: session.id, type: "error", error: e instanceof Error ? e.message : String(e) }),
    );
    return res.status(202).json({ message, streaming: true });
  }

  res.status(201).json({ message });
}
