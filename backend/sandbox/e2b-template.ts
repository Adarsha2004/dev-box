import { Template, defaultBuildLogger } from "e2b";

// E2B counterpart of sandbox/Dockerfile: same base image and tools.
// E2B snapshots the built template, so every sandbox boots from it in well under a second.
export const E2B_TEMPLATE = process.env.E2B_TEMPLATE ?? "devbox-sandbox";

export const template = Template()
  .fromImage("node:22-bookworm-slim")
  .aptInstall(["git", "ca-certificates", "curl", "procps"])
  .runCmd("mkdir -p /workspace && chown user:user /workspace", { user: "root" })
  .setWorkdir("/workspace");

// build once (and again after changing the template): bun sandbox/e2b-template.ts
if (import.meta.main) {
  const info = await Template.build(template, E2B_TEMPLATE, {
    cpuCount: Number(process.env.E2B_CPUS ?? 2),
    memoryMB: Number(process.env.E2B_MEMORY_MB ?? 2048),
    onBuildLogs: defaultBuildLogger(),
  });
  console.log(`built E2B template "${E2B_TEMPLATE}" (${info.templateId})`);
}
