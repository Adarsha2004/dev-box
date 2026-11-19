import { parseArgs } from "node:util";
import { getProvider } from "./providers";
import type { Message,AssistantMessage } from "./types";
import { tools } from "./tools/index";
import { runAgent } from "./agents/loop";

// we parse the cli arguments like this -> bun src/main.ts -p "list the files and read package.json" --provider "openai"
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

// set the provider and model 
const provider = getProvider(values.provider);
const model = values.model ?? provider.defaultModel;

// pass the prompt as message array
// the assistant reply and tools results get appended to this same array later
const messages: Message[] = [{ role: "user", content: values.prompt }];

await runAgent({
  provider,
  model,
  tools,
  messages,
  // onEvent announces what happened or done by llm 
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