import type { Request, Response } from "express";
import { db } from "../DB/db";
import { encryptSecret, decryptSecret } from "./crypto";
import { checkRepoAccess, listAccessibleRepos, parseRepoRef, patHttpError } from "./github";
import { registerRepoSchema, PatSchema, type RepoMeta } from "./types";

// every column except patEncrypted — the encrypted PAT is never fetched from the DB
const SAFE_FIELDS = [
  "id",
  "owner",
  "name",
  "fullName",
  "defaultBranch",
  "patPreview",
  "valid",
  "lastCheckedAt",
  "createdAt",
  "updatedAt",
] as const;

export async function registerRepo(req: Request, res: Response) {
  const result = registerRepoSchema.safeParse(req.body);

  if (!result.success) {
    return res.status(400).json({ error: "invalid repo or pat" });
  }

  const { repo, pat } = result.data;

  const ref = parseRepoRef(repo);
  if (!ref)
    return res.status(400).json({ error: "could not parse repo — use owner/name or a github.com URL" });

  const check = await checkRepoAccess(ref.owner, ref.name, pat);
  if (!check.ok) return res.status(check.status).json({ error: check.error });

  const { repo: savedRepo, created } = await upsertRepo(check.meta, pat);
  if (!savedRepo) return res.status(500).json({ error: "upsert failed" });
  res.status(created ? 201 : 200).json({ repo: savedRepo });
}

// stores the repo with its encrypted PAT, or replaces the token if it already exists;
// the returned row is re-fetched with SAFE_FIELDS so patEncrypted never leaves the DB
async function upsertRepo(meta: RepoMeta, pat: string) {
  const values = {
    owner: meta.owner,
    name: meta.name,
    defaultBranch: meta.defaultBranch,
    patEncrypted: encryptSecret(pat),
    patPreview: pat.slice(-4),
    valid: true,
    lastCheckedAt: new Date(),
  };

  const existing = await db.orm.public.Repo.where({ fullName: meta.fullName }).first();
  if (existing) await db.orm.public.Repo.where({ id: existing.id }).update(values);
  else await db.orm.public.Repo.create({ fullName: meta.fullName, ...values });

  const repo = await db.orm.public.Repo.select(...SAFE_FIELDS).where({ fullName: meta.fullName }).first();
  return { repo, created: !existing };
}


export async function listReposForPat(req: Request, res: Response) {
  const result = PatSchema.safeParse(req.body);

  if (!result.success) {
    return res.status(400).json({
      "error":"invalid pat"
    })
  }

  const { pat } = result.data;

  try {
    const { repos, likelyMore } = await listAccessibleRepos(pat);
    res.json({ count: repos.length, likelyMore, repos });
  } catch (e) {
    const mapped = patHttpError(e);
    if (mapped) return res.status(mapped.status).json({ error: mapped.error });
    throw e;
  }
}


export async function getRepo(req: Request, res: Response) {
  const repo = await db.orm.public.Repo.select(...SAFE_FIELDS).where({ id: Number(req.params.id) }).first();
  if (!repo) return res.status(404).json({ error: "repo not found" });
  res.json({ repo });
}

export async function deleteRepo(req: Request, res: Response) {
  const id = Number(req.params.id);
  const repo = await db.orm.public.Repo.select("fullName").where({ id }).first();
  if (!repo) return res.status(404).json({ error: "repo not found" });
  await db.orm.public.Repo.where({ id }).delete();
  res.json({ deleted: repo.fullName });
}

export async function verifyRepo(req: Request, res: Response) {
  const id = Number(req.params.id);
  const row = await db.orm.public.Repo.where({ id }).first();
  if (!row) return res.status(404).json({ error: "repo not found" });

  let pat: string;
  try {
    pat = decryptSecret(row.patEncrypted);
  } catch {
    return res.json({ valid: false, error: "stored PAT could not be decrypted (key changed?)" });
  }

  const check = await checkRepoAccess(row.owner, row.name, pat);
  await db.orm.public.Repo.where({ id }).update({ valid: check.ok, lastCheckedAt: new Date() });

  if (!check.ok) return res.json({ valid: false, error: check.error });
  res.json({ valid: true, permissions: { pull: check.meta.canPull, push: check.meta.canPush } });
}
