import { CommandExitError, Sandbox as E2BSandbox, TimeoutError } from "e2b";
import type { CreateOptions, ExecOptions, ExecResult, Sandbox, SandboxInfo, SandboxProvider } from "./types";

// the template is built separately (bun sandbox/e2b-template.ts); importing the
// builder here would pull build-only code into the API process
const TEMPLATE = process.env.E2B_TEMPLATE ?? "devbox-sandbox";
const WORKDIR = "/workspace";
// E2B kills a sandbox when its timeout runs out; every exec pushes it forward,
// so this is effectively "max idle time" — the cron sweep usually acts first
const LIFETIME_MS = Number(process.env.E2B_TIMEOUT_MINUTES ?? 60) * 60_000;
const EXTEND_EVERY_MS = 60_000;
const MAX_CAPTURE = 50 * 1024;

function cap(s: string) {
  return s.length > MAX_CAPTURE ? s.slice(0, MAX_CAPTURE) + "\n[truncated]" : s;
}

class E2BBackedSandbox implements Sandbox {
  readonly provider = "e2b";
  private lastExtend = Date.now();

  constructor(
    private readonly sb: E2BSandbox,
    readonly fullName: string,
  ) {}

  get id() {
    return this.sb.sandboxId;
  }

  async exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    if (Date.now() - this.lastExtend > EXTEND_EVERY_MS) {
      this.lastExtend = Date.now();
      void this.sb.setTimeout(LIFETIME_MS).catch(() => {});
    }
    try {
      const r = await this.sb.commands.run(command, {
        cwd: opts.cwd ?? WORKDIR,
        envs: opts.env,
        timeoutMs: (opts.timeout ?? 30) * 1000,
      });
      return { stdout: cap(r.stdout), stderr: cap(r.stderr), exitCode: r.exitCode, timedOut: false };
    } catch (e) {
      // non-zero exit is a normal result, same as the docker driver
      if (e instanceof CommandExitError)
        return { stdout: cap(e.stdout), stderr: cap(e.stderr), exitCode: e.exitCode, timedOut: false };
      if (e instanceof TimeoutError) return { stdout: "", stderr: e.message, exitCode: -1, timedOut: true };
      return { stdout: "", stderr: e instanceof Error ? e.message : String(e), exitCode: -1, timedOut: false };
    }
  }

  async destroy() {
    await this.sb.kill().catch(() => {});
  }
}

async function create({ fullName, pat, labels = {} }: CreateOptions): Promise<Sandbox> {
  const sb = await E2BSandbox.create(TEMPLATE, {
    timeoutMs: LIFETIME_MS,
    metadata: { "devbox.managed": "true", "devbox.repo": fullName, "devbox.createdAt": String(Date.now()), ...labels },
  });
  const sandbox = new E2BBackedSandbox(sb, fullName);

  // same credential-helper trick as the docker driver: the PAT stays out of argv and .git/config
  const cloneCmd = pat
    ? `git -c credential.helper='!f() { echo username=x-access-token; echo password=$SB_PAT; }; f' clone https://github.com/${fullName}.git ${WORKDIR}`
    : `git clone https://github.com/${fullName}.git ${WORKDIR}`;
  const clone = await sandbox.exec(cloneCmd, { cwd: "/", timeout: 180, env: pat ? { SB_PAT: pat } : undefined });
  if (clone.exitCode !== 0) {
    await sandbox.destroy();
    throw new Error(`clone failed: ${clone.stderr || clone.stdout}`);
  }
  return sandbox;
}

async function get(id: string): Promise<Sandbox | null> {
  try {
    const sb = await E2BSandbox.connect(id, { timeoutMs: LIFETIME_MS });
    const info = await sb.getInfo();
    return new E2BBackedSandbox(sb, info.metadata["devbox.repo"] ?? "");
  } catch {
    return null; // killed or expired
  }
}

async function list(): Promise<SandboxInfo[]> {
  const out: SandboxInfo[] = [];
  const pages = E2BSandbox.list({ query: { metadata: { "devbox.managed": "true" } } });
  while (pages.hasNext) {
    for (const s of await pages.nextItems()) {
      out.push({
        id: s.sandboxId,
        provider: "e2b",
        fullName: s.metadata["devbox.repo"] ?? null,
        running: s.state === "running",
        child: s.metadata["devbox.child"] === "true",
        createdAt: Number(s.metadata["devbox.createdAt"]) || s.startedAt.getTime(),
      });
    }
  }
  return out;
}

export const e2bProvider: SandboxProvider = { name: "e2b", create, get, list };
