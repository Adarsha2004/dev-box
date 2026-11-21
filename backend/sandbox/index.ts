import type { SandboxProvider } from "./types";
import { dockerProvider } from "./docker";

// add a driver here (e.g. "e2b", "firecracker") and switch via SANDBOX_DRIVER env —
// nothing else in the app changes
const providers: Record<string, SandboxProvider> = {
  docker: dockerProvider,
};

export function getSandboxProvider(name = process.env.SANDBOX_DRIVER ?? "docker"): SandboxProvider {
  const provider = providers[name];
  if (!provider)
    throw new Error(`unknown sandbox driver "${name}" — available: ${Object.keys(providers).join(", ")}`);
  return provider;
}

export type { Sandbox, SandboxProvider, SandboxInfo, ExecResult, ExecOptions, CreateOptions } from "./types";
