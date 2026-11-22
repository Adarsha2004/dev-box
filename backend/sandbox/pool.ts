import type { CreateOptions, Sandbox } from "./types";
import { getSandboxProvider } from ".";

type Idle = { sandbox: Sandbox; since: number };

// pre-creates sandboxes so spawn_agent doesn't pay docker run + git clone.
// warm() is fire-and-forget; acquire() falls back to a cold create when empty.
export class SandboxPool {
  private idle = new Map<string, Idle[]>(); // repo fullName → warm sandboxes
  private warming = new Set<string>(); // repos with a warm-up in flight
  private leased = new Set<string>(); // handed out, not yet destroyed

  constructor(
    private readonly min = Number(process.env.POOL_MIN ?? 2),
    private readonly idleTtlMs = Number(process.env.POOL_IDLE_TTL_MINUTES ?? 15) * 60_000,
  ) {}

  warm(opts: CreateOptions): void {
    if (this.warming.has(opts.fullName)) return;
    if ((this.idle.get(opts.fullName)?.length ?? 0) >= this.min) return;

    this.warming.add(opts.fullName);
    this.fill(opts).finally(() => this.warming.delete(opts.fullName));
  }

  private async fill(opts: CreateOptions): Promise<void> {
    const list = this.idle.get(opts.fullName) ?? [];
    this.idle.set(opts.fullName, list);
    while (list.length < this.min) {
      try {
        list.push({ sandbox: await getSandboxProvider().create(opts), since: Date.now() });
      } catch (e) {
        console.error(`[pool] warm failed for ${opts.fullName}:`, e instanceof Error ? e.message : e);
        return;
      }
    }
  }

  async acquire(opts: CreateOptions): Promise<Sandbox> {
    const warm = this.idle.get(opts.fullName)?.shift();
    this.warm(opts); // replenish in the background either way
    const inner = warm?.sandbox ?? (await getSandboxProvider().create(opts));
    this.leased.add(inner.id);
    return leased(this, inner);
  }

  release(id: string): void {
    this.leased.delete(id);
  }

  // destroy idle sandboxes that sat unused past the TTL; returns how many
  async reap(): Promise<number> {
    let count = 0;
    for (const [repo, list] of this.idle) {
      const keep = list.filter((item) => {
        if (Date.now() - item.since <= this.idleTtlMs) return true;
        count++;
        void item.sandbox.destroy().catch(() => {});
        return false;
      });
      if (keep.length) this.idle.set(repo, keep);
      else this.idle.delete(repo);
    }
    return count;
  }

  // still owned by the pool (idle or leased)? cron must not reap these
  knows(id: string): boolean {
    if (this.leased.has(id)) return true;
    for (const list of this.idle.values()) if (list.some((i) => i.sandbox.id === id)) return true;
    return false;
  }
}

// a sandbox whose destroy() tells the pool the lease is over
function leased(pool: SandboxPool, inner: Sandbox): Sandbox {
  return {
    id: inner.id,
    provider: inner.provider,
    fullName: inner.fullName,
    exec: (command, opts) => inner.exec(command, opts),
    async destroy() {
      await inner.destroy();
      pool.release(inner.id);
    },
  };
}

export const pool = new SandboxPool();
