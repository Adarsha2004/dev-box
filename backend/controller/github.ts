import axios from "axios";
import type { AccessibleRepo, GithubRepo, HttpError, PatCheck, RepoMeta, RepoRef } from "./types";

const api = axios.create({
  baseURL: "https://api.github.com",
  headers: {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "dev-box",
  },
});

// accepts "owner/name", "https://github.com/owner/name(.git)", "git@github.com:owner/name(.git)"
export function parseRepoRef(input: string): RepoRef | null {
  const s = input.trim();

  const https = s.match(/^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i);
  if (https) return { owner: https[1]!, name: https[2]! };

  const ssh = s.match(/^git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/i);
  if (ssh) return { owner: ssh[1]!, name: ssh[2]! };

  const shorthand = s.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (shorthand) return { owner: shorthand[1]!, name: shorthand[2]! };

  return null;
}

export async function checkRepoAccess(owner: string, name: string, pat: string): Promise<PatCheck> {
  let data: GithubRepo;

  try {
    const res = await api.get(`/repos/${owner}/${name}`, {
      headers: { Authorization: `Bearer ${pat}` },
    });
    data = res.data;
  } catch (e) {
    if (!axios.isAxiosError(e))
      return { ok: false, status: 502, error: `could not reach GitHub: ${String(e)}` };

    const status = e.response?.status;
    if (status === 401) return { ok: false, status: 401, error: "invalid or expired PAT" };
    if (status === 404)
      return { ok: false, status: 404, error: `repo not found, or PAT has no access to ${owner}/${name}` };
    if (status === 403) return { ok: false, status: 403, error: "forbidden or rate limited by GitHub" };
    return { ok: false, status: 502, error: `unexpected GitHub response (${status ?? "no response"})` };
  }

  const meta: RepoMeta = {
    owner: data.owner.login,
    name: data.name,
    fullName: `${data.owner.login}/${data.name}`,
    isPrivate: data.private,
    defaultBranch: data.default_branch,
    canPull: data.permissions?.pull ?? false,
    canPush: data.permissions?.push ?? false,
  };

  if (!meta.canPull)
    return { ok: false, status: 403, error: "PAT cannot read this repo (needs Contents: read permission)" };

  return { ok: true, meta };
}


export async function listAccessibleRepos(
  pat: string,
): Promise<{ repos: AccessibleRepo[]; likelyMore: boolean }> {
  const res = await api.get<GithubRepo[]>("/user/repos", {
    headers: { Authorization: `Bearer ${pat}` },
    params: { per_page: 100, sort: "full_name" },
  });

  const repos = res.data
    .filter((r) => r.permissions?.pull !== false)
    .map((r) => ({
      fullName: r.full_name,
      isPrivate: r.private,
      defaultBranch: r.default_branch,
      canPull: r.permissions?.pull ?? false,
      canPush: r.permissions?.push ?? false,
    }));
  return { repos, likelyMore: repos.length === 100 };
}

// maps an axios error from a PAT-authed GitHub call to an HTTP status + message
export function patHttpError(e: unknown): HttpError {
  if (!axios.isAxiosError(e)) return null;
  const status = e.response?.status;
  if (status === 401) return { status: 401, error: "invalid or expired PAT" };
  if (status === 403) return { status: 403, error: "forbidden or rate limited by GitHub" };
  if (status === 404) return { status: 404, error: "not found" };
  return null;
}
