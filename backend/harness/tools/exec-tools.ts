import type { Tool } from "../types";
import { truncateTail } from "./bash";
import { bashTool } from "./bash";
import { readTool } from "./read";

// any exec target works here: a docker sandbox, the local host, a remote VM.
// the harness stays independent of the sandbox layer
export type ExecFn = (
  command: string,
  opts?: { cwd?: string; env?: Record<string, string>; timeout?: number },
) => Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }>;

async function execBash(exec: ExecFn, args: Record<string, unknown>): Promise<string> {
  const r = await exec(String(args.command), {
    timeout: typeof args.timeout === "number" ? args.timeout : 30,
  });
  const out = (r.stdout + (r.stderr ? "\n" + r.stderr : "")) || "(no output)";
  return truncateTail(`${out}\n[exit code: ${r.exitCode}${r.timedOut ? " (timed out)" : ""}]`);
}

async function execRead(exec: ExecFn, args: Record<string, unknown>): Promise<string> {
  const r = await exec(`cat ${JSON.stringify(String(args.path))}`, { timeout: 10 });
  if (r.exitCode !== 0) return `error: ${r.stderr.trim() || r.stdout.trim()}`;
  return truncateTail(r.stdout);
}

// same tools as the local ones — only the execution target is swapped
export function makeTools(exec: ExecFn): Tool[] {
  return [
    { ...readTool, execute: (args) => execRead(exec, args) },
    { ...bashTool, execute: (args) => execBash(exec, args) },
  ];
}
