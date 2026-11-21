import { z } from "zod";

export const registerRepoSchema = z.object({
  repo: z.string().trim().min(1),
  pat: z.string().trim().min(1),
});

export const PatSchema = z.object({
  pat: z.string().trim().min(1),
});

export type RegisterRepoBody = z.infer<typeof registerRepoSchema>;
export type PatBody = z.infer<typeof PatSchema>;

export const createMessageSchema = z.object({
  content: z.string().trim().min(1),
  role: z.enum(["user", "assistant"]).default("user"),
});

export type CreateMessageBody = z.infer<typeof createMessageSchema>;

export type GithubRepo = {
  name: string;
  full_name: string;
  owner: { login: string };
  private: boolean;
  default_branch: string;
  permissions?: { pull?: boolean; push?: boolean };
};

export type RepoRef = { owner: string; name: string };

export type RepoMeta = {
  owner: string;
  name: string;
  fullName: string;
  isPrivate: boolean;
  defaultBranch: string;
  canPull: boolean;
  canPush: boolean;
};

export type PatCheck =
  | { ok: true; meta: RepoMeta }
  | { ok: false; status: number; error: string };

export type AccessibleRepo = {
  fullName: string;
  isPrivate: boolean;
  defaultBranch: string;
  canPull: boolean;
  canPush: boolean;
};

export type HttpError = { status: number; error: string } | null;
