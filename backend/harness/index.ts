import { parseArgs } from "node:util";
import { getProvider } from "./providers";
import type { Message,AssistantMessage } from "./types";
import { tools } from "./tools/index";
import { runAgent } from "./agents/loop";

const { values } = parseArgs({
  options: {
    prompt: { type: "string", short: "p" },
    provider: { type: "string", default: "groq-openai" },
    model: { type: "string" },
  },
});

if (!values.prompt) {
  console.error(`no prompt, atas -p "prompt" --provider "provider_name"`);
  process.exit(1);
}

const provider = getProvider(values.provider);
const model = values.model ?? provider.defaultModel;

const messages: Message[] = [{ role: "user", content: values.prompt }];

await runAgent({
  provider,
  model,
  tools,
  messages,
  onEvent(event) {
    if (event.type === "text") process.stdout.write(event.delta);
    else if (event.type == "tool_start") console.log(`\n ${event.call.name}`);
    else if (event.type == "tool_end") {
      const lines = event.result.split("\n").length;
      console.log(`\n ${event.isError ? event.result : lines}`);
    } else if (event.type === "turn_end") {
      const { usage, stopReason } = event.message;
      console.log(
        `\n\n  ${provider.name} ... ${model} ... ${usage.input} ... ${usage.output} ... ${stopReason}`,
      );
    }
  },
});