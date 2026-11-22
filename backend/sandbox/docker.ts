import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { CreateOptions, ExecOptions, ExecResult, Sandbox, SandboxInfo, SandboxProvider } from "./types";

const IMAGE = "devbox-sandbox:latest";
const NAME_PREFIX = "devbox-sb-";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_CAPTURE = 50 * 1024;

type RunResult = { stdout: string; stderr: string; code: number; timedOut: boolean };

function cap(s: string) {
  return s.length > MAX_CAPTURE ? s.slice(0, MAX_CAPTURE) + "\n[truncated]" : s;
}

// thin wrapper around the docker CLI — same pattern as the harness bash tool
function docker(args: string[], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ stdout: cap(stdout), stderr: cap(stderr) + e.message, code: -1, timedOut: false });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout: cap(stdout), stderr: cap(stderr), code: code ?? -1, timedOut });
    });
  });
}

// build the sandbox image once; concurrent calls share one build
let imageReady: Promise<void> | null = null;
function ensureImage(): Promise<void> {
  imageReady ??= (async () => {
    const existing = await docker(["image", "inspect", IMAGE]);
    if (existing.code === 0) return;
    const build = await docker(["build", "-q", "-t", IMAGE, import.meta.dir], 300_000);
    if (build.code !== 0) throw new Error(`docker build failed: ${build.stderr}`);
  })();
  return imageReady;
}

class DockerSandbox implements Sandbox {
  readonly provider = "docker";

  constructor(
    readonly id: string,
    readonly fullName: string,
  ) {}

  async exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const args = ["exec"];
    if (opts.cwd) args.push("-w", opts.cwd);
    for (const [k, v] of Object.entries(opts.env ?? {})) args.push("-e", `${k}=${v}`);
    args.push(NAME_PREFIX + this.id, "bash", "-c", command);

    const r = await docker(args, (opts.timeout ?? 30) * 1000);
    return { stdout: r.stdout, stderr: r.stderr, exitCode: r.timedOut ? -1 : r.code, timedOut: r.timedOut };
  }

  async destroy() {
    await docker(["rm", "-f", NAME_PREFIX + this.id]);
  }
}

// stateless — rebuilds the instance from container metadata, so backend
// restarts (or multiple instances) see the same sandboxes
async function fromId(id: string): Promise<Sandbox | null> {
  const r = await docker([
    "inspect",
    NAME_PREFIX + id,
    "--format",
    `{{.State.Running}}|{{index .Config.Labels "devbox.repo"}}`,
  ]);
  if (r.code !== 0) return null;
  const [running, fullName] = r.stdout.trim().split("|");
  return new DockerSandbox(id, fullName ?? "");
}

async function create({ fullName, pat, labels = {} }: CreateOptions): Promise<Sandbox> {
  await ensureImage();

  const id = randomBytes(6).toString("hex");
  const labelArgs = Object.entries(labels).flatMap(([k, v]) => ["--label", `${k}=${v}`]);
  const run = await docker(
    [
      "run",
      "-d",
      "--name",
      NAME_PREFIX + id,
      "-w",
      "/workspace",
      "--label",
      "devbox.managed=true",
      "--label",
      `devbox.repo=${fullName}`,
      "--label",
      `devbox.createdAt=${Date.now()}`,
      ...labelArgs,
      IMAGE,
      "bash",
      "-c",
      "sleep infinity",
    ],
    60_000,
  );
  if (run.code !== 0) throw new Error(`docker run failed: ${run.stderr}`);

  const sandbox = new DockerSandbox(id, fullName);

  // clone with the PAT passed through a credential helper via env —
  // the token never appears in argv or inside .git/config
  const cloneCmd = pat
    ? `git -c credential.helper='!f() { echo username=x-access-token; echo password=$SB_PAT; }; f' clone https://github.com/${fullName}.git /workspace`
    : `git clone https://github.com/${fullName}.git /workspace`;
  const clone = await sandbox.exec(cloneCmd, { timeout: 180, env: pat ? { SB_PAT: pat } : undefined });
  if (clone.exitCode !== 0) {
    await sandbox.destroy();
    throw new Error(`clone failed: ${clone.stderr || clone.stdout}`);
  }

  return sandbox;
}

async function list(): Promise<SandboxInfo[]> {
  // docker ps exposes .Labels as a slice ("k=v k=v"), not a map — parse it in JS
  const r = await docker([
    "ps",
    "-a",
    "--filter",
    "label=devbox.managed",
    "--format",
    `{{.Names}}|{{.State}}|{{.Labels}}`,
  ]);
  if (r.code !== 0) return [];
  return r.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, state, labelsRaw = ""] = line.split("|");
      const labels = labelsRaw.replace(/^\[|\]$/g, "").split(/[,\s]+/);
      const repo = labels.find((l) => l.startsWith("devbox.repo="));
      const child = labels.find((l) => l === "devbox.child=true");
      const createdAt = labels.find((l) => l.startsWith("devbox.createdAt="));
      return {
        id: name!.slice(NAME_PREFIX.length),
        provider: "docker",
        fullName: repo ? repo.slice("devbox.repo=".length) : null,
        running: state === "running",
        child: Boolean(child),
        createdAt: createdAt ? Number(createdAt.slice("devbox.createdAt=".length)) : undefined,
      };
    });
}

export const dockerProvider: SandboxProvider = {
  name: "docker",
  create,
  get: fromId,
  list,
};
