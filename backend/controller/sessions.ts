import type { Request, Response } from "express";
import { db } from "../DB/db";
import { decryptSecret } from "./crypto";
import { getSandboxProvider } from "../sandbox";
import { createMessageSchema } from "./types";

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

  res.status(201).json({ message });
}
