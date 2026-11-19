import type { Provider } from "../types";
import { createOpenAICompat } from "./openai-compat";

const providers: Record<string, () => Provider> = {
  "anthropic-openai": () => createOpenAICompat("antropic-openai", "https://api.anthropic.com/v1/", process.env.ANTHROPIC_API_KEY!, "claude-sonnet-5"),
  "groq-openai": () => createOpenAICompat("groq", "https://api.groq.com/openai/v1", process.env.GROQ_API_KEY!, "qwen/qwen3.8-27b")
}

export function getProvider(name: string) {
  const create = providers[name];
  if(!create) throw new Error("soemthing is wrong")
  return create();
}