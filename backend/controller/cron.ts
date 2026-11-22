import { db } from "../DB/db";
import { getSandboxProvider } from "../sandbox";
import { pool } from "../sandbox/pool";

const IDLE_TTL_MINUTES = Number(process.env.IDLE_TTL_MINUTES ?? 30);
const SWEEP_INTERVAL_MS = 60_000;
const ORPHAN_TTL_MS = Number(process.env.ORPHAN_TTL_MINUTES ?? 15) * 60_000;

let sweeping = false;

// destroys primary sandboxes of active sessions that had no activity for IDLE_TTL;
// the session row stays active — it self-heals (new sandbox) on the next open
export async function sweepIdleSandboxes() {
  if (sweeping) return;
  sweeping = true;
  try {
    const cutoff = new Date(Date.now() - IDLE_TTL_MINUTES * 60_000);
    const active = await db.orm.public.Session.where({ status: "active" }).all();

    for (const session of active) {
      if (!session.sandboxId || session.lastMessageAt >= cutoff) continue;

      const sandbox = await getSandboxProvider().get(session.sandboxId);
      if (sandbox) await sandbox.destroy();
      await db.orm.public.Session.where({ id: session.id }).update({ sandboxId: null });
      console.log(`[cron] destroyed idle sandbox ${session.sandboxId} (session ${session.id})`);
    }

    // pool: drop sandboxes nobody claimed for a while
    const reaped = await pool.reap();
    if (reaped) console.log(`[cron] reaped ${reaped} pooled sandboxes`);

    // children are short-lived; any child container older than ORPHAN_TTL is a
    // leak from a crashed run — destroy it unless the pool still owns/leases it
    const provider = getSandboxProvider();
    const all = await provider.list();
    const cutoffMs = Date.now() - ORPHAN_TTL_MS;
    for (const s of all) {
      if (!s.child || !s.createdAt || s.createdAt >= cutoffMs) continue;
      if (pool.knows(s.id)) continue;
      const sandbox = await provider.get(s.id);
      if (sandbox) await sandbox.destroy();
      console.log(`[cron] destroyed orphan child sandbox ${s.id}`);
    }
  } catch (e) {
    console.error("[cron] sweep failed:", e);
  } finally {
    sweeping = false;
  }
}

export function startCron() {
  void sweepIdleSandboxes(); // run once at boot, then every minute
  setInterval(() => void sweepIdleSandboxes(), SWEEP_INTERVAL_MS);
}
