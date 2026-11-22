import { runAgent, type AgentEvent } from "../harness/agents/loop";
import type { Message, Provider, Tool } from "../harness/types";
import { makeTools } from "../harness/tools/exec-tools";
import type { Sandbox } from "../sandbox";
import { CHILD_SYSTEM, PRIMARY_SYSTEM, extractDiff, makeSpawnTools, type ChildResult, type TaggedEvent } from "./spawn";

export type { TaggedEvent } from "./spawn";

export type RunTreeOptions = {
  provider: Provider;
  model: string;
  system?: string;
  prompt: string;
  acquireChild: () => Promise<Sandbox>;
  primary?: Sandbox; // reuse the session's sandbox instead of acquiring one
  destroyPrimary?: boolean;
  maxDepth?: number;
  maxChildren?: number;
  onEvent?: (event: TaggedEvent) => void;
};

type Ctx = Required<Pick<RunTreeOptions, "provider" | "model" | "acquireChild" | "maxDepth" | "maxChildren" | "onEvent">> & {
  children: number; // total children spawned this run, for the limit
};

export async function runTree(opts: RunTreeOptions): Promise<{ summary: string }> {
  const ctx: Ctx = {
    provider: opts.provider,
    model: opts.model,
    acquireChild: opts.acquireChild,
    maxDepth: opts.maxDepth ?? 1,
    maxChildren: opts.maxChildren ?? 8,
    onEvent: opts.onEvent ?? (() => {}),
    children: 0,
  };

  // primary: reuse the session sandbox if given, else acquire + destroy our own
  const ownsPrimary = !opts.primary;
  const primary = opts.primary ?? (await ctx.acquireChild());

  let summary = "";
  try {
    await runAgent({
      provider: ctx.provider,
      model: ctx.model,
      system: opts.system ?? PRIMARY_SYSTEM,
      tools: toolsFor(ctx, primary, 0, "a"),
      messages: [{ role: "user", content: opts.prompt }],
      onEvent: (e) => {
        if (e.type === "text") summary += e.delta;
        ctx.onEvent({ ...e, agentId: "primary", depth: 0 });
      },
    });
  } finally {
    if (opts.destroyPrimary ?? ownsPrimary) await primary.destroy().catch(() => {});
  }
  return { summary };
}

// tools for one agent: bash/read against its sandbox, plus spawn tools
// (only when recursion depth allows — children can't spawn at maxDepth)
function toolsFor(ctx: Ctx, sandbox: Sandbox, depth: number, idPrefix: string): Tool[] {
  const tools = makeTools((cmd, opts) => sandbox.exec(cmd, opts));
  if (depth + 1 > ctx.maxDepth) return tools;

  let n = 0;
  return [
    ...tools,
    ...makeSpawnTools({
      canSpawn: () => (ctx.children >= ctx.maxChildren ? `child limit reached (${ctx.maxChildren})` : null),
      start: (prompt) => {
        ctx.children++;
        const agentId = `${idPrefix}${++n}`;
        return { id: agentId, done: runChild(ctx, { agentId, prompt, depth: depth + 1 }) };
      },
    }),
  ];
}

async function runChild(ctx: Ctx, { agentId, prompt, depth }: { agentId: string; prompt: string; depth: number }): Promise<ChildResult> {
  let sandbox: Sandbox;
  try {
    sandbox = await ctx.acquireChild();
  } catch (e) {
    return { id: agentId, ok: false, summary: `sandbox create failed: ${e instanceof Error ? e.message : String(e)}`, diff: "" };
  }

  let summary = "";
  try {
    await runAgent({
      provider: ctx.provider,
      model: ctx.model,
      system: CHILD_SYSTEM,
      tools: toolsFor(ctx, sandbox, depth, agentId + "."),
      messages: [{ role: "user", content: prompt }],
      onEvent: (e: AgentEvent) => {
        if (e.type === "text") summary += e.delta;
        ctx.onEvent({ ...e, agentId, depth });
      },
    });
    return { id: agentId, ok: true, summary: summary.trim(), diff: await extractDiff(sandbox) };
  } catch (e) {
    return { id: agentId, ok: false, summary: e instanceof Error ? e.message : String(e), diff: "" };
  } finally {
    await sandbox.destroy().catch(() => {}); // never rejects — failures already captured above
  }
}
