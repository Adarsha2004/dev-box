import OpenAI from "openai";
import type { Provider, StopReason, Usage, Message, ContentBlock } from "../types";

// this function works along the Message[] ans maps each entry into the shape the OpenAI-compat endpoint expects
function formatChat(messages: Message[]): OpenAI.ChatCompletionMessageParam[] {
  return messages.map((m): OpenAI.ChatCompletionMessageParam => {
    // user text is unchanged
    if (m.role === "user") return { role: "user", content: m.content };
    // the text response of assistant is grouped together and tool calls are grouped together
    if (m.role === "assistant") {
      const text = m.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");
      const calls = m.content.filter((b) => b.type === "toolCall");
      return {
        role: "assistant",
        content: text || null,
        tool_calls: calls.length
          ? calls.map((c) => ({
              id: c.id,
              type: "function" as const,
              function: {
                name: c.name,
                arguments: JSON.stringify(c.arguments),
              },
            }))
          : undefined,
      };
    }
    // handles the tool call conversion
    return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
  });
}

export function createOpenAICompat(
  name: string,
  baseURL: string,
  apiKey: string,
  defaultModel: string,
): Provider {
  const client = new OpenAI({ baseURL, apiKey });
  return {
    name,
    defaultModel,
    // * makes the function a generator it does not returns it yields event as LLM produces them
    async *stream({ messages, model, system, tools = [] }) {
      const chat = formatChat(messages);

      const stream = await client.chat.completions.create({
        model,
        stream: true, //SSE to send chunks
        stream_options: { include_usage: true },
        messages: system
          ? [{ role: "system", content: system }, ...chat]
          : chat,
        tools: tools.length
          ? tools.map((t) => ({
              type: "function" as const,
              function: {
                name: t.name,
                description: t.description,
                parameters: t.parameters,
              },
            }))
          : undefined,
      });

      // defines all state that gets filled as chunks arrives from stream
      let text = "";
      const calls: { id: string; name: string; args: string }[] = [];
      let usage: Usage = { input: 0, output: 0 };
      let stopReason: StopReason = "stop";
      
      for await (const chunk of stream) {
        // text chunk passes through immediately
        const choice = chunk.choices[0];
        if (choice?.delta.content) {
          text += choice.delta.content;
          yield { type: "text_delta", delta: choice.delta.content };
        }
        // the tc is also split into many chunks we need to handle that
        for (const tc of choice?.delta.tool_calls ?? []) {
          const call = (calls[tc.index] ??= {
            id: tc.id ?? `call_${tc.index}`,
            name: tc.function?.name ?? "",
            args: "",
          });
          call.args += tc.function?.arguments ?? "";
        }
        //metadata at finish
        if (choice?.finish_reason === "tool_calls") stopReason = "toolUse"; // llm sends tool_calls we have set its type as "toolUse"
        else if (choice?.finish_reason === "length") stopReason = "length";
        if (chunk.usage) {
          usage = {
            input: chunk.usage.prompt_tokens,
            output: chunk.usage.completion_tokens,
          };
        }
      }

      // After stream we need to keep the contents
      // text block only if text exists
      const content: ContentBlock[] = text ? [{ type: "text", text }] : [];

      // push all tool calls to content
      for (const c of calls) {
        if (c)
          content.push({
            type: "toolCall",
            id: c.id,
            name: c.name,
            arguments: JSON.parse(c.args),
          });
      }

      if (content.some((b) => b.type === "toolCall")) stopReason = "toolUse";

      // done event wraps everything
      yield {
        type: "done",
        message: { role: "assistant", content, usage, stopReason },
      };
    },
  };
}
