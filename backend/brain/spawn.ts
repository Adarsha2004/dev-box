import type { AgentEvent } from "../harness/agents/loop";
import type { Tool } from "../harness/types";
import type { Sandbox } from "../sandbox";

export type TaggedEvent = AgentEvent & { agentId: string; depth: number };
export type ChildResult = { id: string; ok: boolean; summary: string; diff: string };

export const CHILD_SYSTEM = `You are a sub-agent working in an isolated copy of the repository.
Do exactly the task you were given, verify your changes if possible, then reply with a short summary of what you changed and why.`;

export const PRIMARY_SYSTEM = `You are an autonomous coding agent working in a sandbox that contains a git repository (your bash tool runs inside it).

How you work:
- Explore before you edit: read the relevant files and understand the structure first.
- Make your changes with the smallest correct diff; prefer editing over rewriting files.
- Always verify: run the project's tests/build/lint after changes if any exist; if they fail, iterate until green or explain why not.
- Never git commit or push — leave your changes in the working tree.

Working in parallel:
- If the task contains independent subtasks, spawn one sub-agent each with spawn_agent. Prompts must be completely self-contained (the sub-agent cannot see this conversation) and must not depend on each other's output.
- Sequential or tightly coupled work: do it yourself.
- Collect results with wait_agents. Each result contains a summary and a unified diff — apply diffs with \`git apply\` (or the patch content it provides); never recreate the files by hand.
- Sub-agent workspaces are disposable copies; their changes only reach your workspace through the diffs you apply.

Final answer:
- A concise report: what changed and why, how it was verified (commands + outcomes), and anything left un-done.`;

export function makeSpawnTools(deps: {
  canSpawn: () => string | null;
  start: (prompt: string) => { id: string; done: Promise<ChildResult> };
}): Tool[] {
  const pending = new Map<string, Promise<ChildResult>>();

  const spawnTool: Tool = {
    name: "spawn_agent",
    description:
      "Spawn a sub-agent in its own isolated workspace to work on an independent subtask in parallel. Returns immediately with the agent id. Spawn several for parallel work, then call wait_agents to collect results — each result includes a summary and a unified diff you can apply in your workspace with `git apply`. Use this when subtasks are independent; do the work yourself when they are not.",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "Complete, self-contained task for the sub-agent (it cannot see your conversation)",
        },
      },
      required: ["prompt"],
    },
    async execute(args) {
      const deny = deps.canSpawn();
      if (deny) return deny;
      const { id, done } = deps.start(String(args.prompt));
      pending.set(id, done);
      return `spawned agent ${id} — call wait_agents to collect its result`;
    },
  };

  const waitTool: Tool = {
    name: "wait_agents",
    description:
      "Wait for spawned sub-agents and return their results. Waits for all pending agents unless specific ids are given.",
    parameters: {
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "string" }, description: "Specific agent ids (default: all pending)" },
      },
    },
    async execute(args) {
      const ids =
        Array.isArray(args.ids) && args.ids.length
          ? args.ids.map(String).filter((id) => pending.has(id))
          : [...pending.keys()];
      if (!ids.length) return "no pending agents";
      const results = await Promise.all(ids.map((id) => pending.get(id)!));
      for (const id of ids) pending.delete(id);
      return results.map(formatResult).join("\n\n");
    },
  };

  return [spawnTool, waitTool];
}

function formatResult(r: ChildResult): string {
  const diff = r.diff
    ? `\n<diff>\n${r.diff.slice(0, 8000)}${r.diff.length > 8000 ? "\n[diff truncated]" : ""}\n</diff>`
    : "";
  return `--- agent ${r.id} ${r.ok ? "done" : "FAILED"}\nsummary: ${r.summary || "(none)"}${diff}`;
}

export async function extractDiff(sandbox: Sandbox): Promise<string> {
  const add = await sandbox.exec("git add -A", { timeout: 30 });
  if (add.exitCode !== 0) return "";
  const diff = await sandbox.exec("git diff --cached", { timeout: 30 });
  return diff.exitCode === 0 ? diff.stdout.trim() : "";
}
