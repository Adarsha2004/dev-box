// Sandbox benchmark: cold vs warm startup, and how many sandboxes run at once.
// No LLM calls — measures the infrastructure an agent runs on.
//   SANDBOX_DRIVER=docker|e2b bun bench/sandbox-bench.ts [repo] [levels]
//   e.g. bun bench/sandbox-bench.ts octocat/Hello-World 10,25,50,100
import { getSandboxProvider, type Sandbox } from "../sandbox";
import { SandboxPool } from "../sandbox/pool";

const repo = process.argv[2] ?? "octocat/Hello-World";
const levels = (process.argv[3] ?? "10,25,50,100").split(",").map(Number);
const opts = { fullName: repo, pat: "", labels: { "devbox.bench": "true" } };
const provider = getSandboxProvider();

const now = () => performance.now();
const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const p = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
  return `p50 ${(p(0.5) / 1000).toFixed(2)}s  p95 ${(p(0.95) / 1000).toFixed(2)}s  min ${(s[0]! / 1000).toFixed(2)}s  max ${(s.at(-1)! / 1000).toFixed(2)}s`;
};

async function cleanup() {
  for (const s of await provider.list()) if (s.fullName === repo) await (await provider.get(s.id))?.destroy();
}

// 1. startup: cold create (docker run + git clone) vs warm pool acquire
async function startup(runs = 5) {
  console.log(`\n== startup [${provider.name}] (${repo}, ${runs} runs) ==`);
  await (await provider.create(opts)).destroy(); // warm-up (docker image build / first API call), not counted

  const cold: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t = now();
    const sb = await provider.create(opts);
    await sb.exec("git -C /workspace rev-parse HEAD");
    cold.push(now() - t);
    await sb.destroy();
  }
  console.log(`cold create : ${stats(cold)}`);

  const pool = new SandboxPool(runs, 60 * 60_000);
  pool.warm(opts);
  while (!(pool as any).idle.get(repo) || (pool as any).idle.get(repo).length < runs) await Bun.sleep(200);
  const warm: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t = now();
    const sb = await pool.acquire(opts);
    await sb.exec("git -C /workspace rev-parse HEAD");
    warm.push(now() - t);
    await sb.destroy();
  }
  console.log(`warm acquire: ${stats(warm)}`);
  await Bun.sleep(1000);
  await cleanup(); // pool refills in the background — drop those
}

// 2. concurrency: N sandboxes created at once, all alive together, each running
//    an agent-like workload (read files, grep, write, git diff)
async function concurrency(n: number) {
  const t0 = now();
  const results = await Promise.allSettled(
    Array.from({ length: n }, async () => {
      const t = now();
      const sb = await provider.create(opts);
      return { sb, ms: now() - t };
    }),
  );
  const up = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  const createWall = now() - t0;

  const work = "ls -la && cat README* >/dev/null; grep -r . -l | head; echo x >> bench.txt && git diff --stat";
  const t1 = now();
  const execs = await Promise.allSettled(up.map(({ sb }) => sb.exec(work, { timeout: 60 })));
  const execOk = execs.filter((r) => r.status === "fulfilled" && r.value.exitCode === 0).length;
  const execWall = now() - t1;

  const fails = results.filter((r) => r.status === "rejected").map((r) => String((r as PromiseRejectedResult).reason).slice(0, 120));
  console.log(
    `N=${n}: ${up.length}/${n} up, ${execOk}/${up.length} workloads ok | create wall ${(createWall / 1000).toFixed(1)}s, per-sandbox ${up.length ? stats(up.map((u) => u.ms)) : "-"} | workload wall ${(execWall / 1000).toFixed(1)}s`,
  );
  if (fails.length) console.log(`  first failure: ${fails[0]}`);
  await Promise.all(up.map(({ sb }: { sb: Sandbox }) => sb.destroy()));
  return up.length === n && execOk === n;
}

try {
  await cleanup();
  await startup();
  console.log(`\n== concurrency [${provider.name}] ==`);
  for (const n of levels) if (!(await concurrency(n))) break;
} finally {
  await cleanup();
}
process.exit(0);
