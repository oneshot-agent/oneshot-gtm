import { llmApiKey, loadConfig } from "@oneshot-gtm/core";
import { loadPrompt } from "./prompts.ts";

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmCompleteInput {
  messages: LlmMessage[];
  temperature?: number;
  maxTokens?: number;
}

export interface LlmCompleteOutput {
  content: string;
  provider: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
}

export class LlmError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

let humanizerPrologueCache: string | null = null;
function humanizerPrologue(): string {
  if (humanizerPrologueCache !== null) return humanizerPrologueCache;
  try {
    humanizerPrologueCache = loadPrompt("_humanizer");
  } catch {
    humanizerPrologueCache = "";
  }
  return humanizerPrologueCache;
}

function injectHumanizer(messages: LlmMessage[]): LlmMessage[] {
  const prologue = humanizerPrologue();
  if (!prologue) return messages;
  const sysIdx = messages.findIndex((m) => m.role === "system");
  if (sysIdx < 0) {
    return [{ role: "system", content: prologue }, ...messages];
  }
  const sys = messages[sysIdx];
  if (!sys) return messages;
  if (sys.content.includes("_humanizer.md") || sys.content.includes("Anti-AI-slop rules")) {
    const out: LlmMessage[] = messages.slice();
    out[sysIdx] = { role: "system", content: `${prologue}\n\n---\n\n${sys.content}` };
    return out;
  }
  return messages;
}

export async function complete(input: LlmCompleteInput): Promise<LlmCompleteOutput> {
  const cfg = loadConfig();
  const key = llmApiKey(cfg.llmProvider);
  if (!key) {
    const envName = {
      openrouter: "OPENROUTER_API_KEY",
      openai: "OPENAI_API_KEY",
      anthropic: "ANTHROPIC_API_KEY",
    }[cfg.llmProvider];
    throw new LlmError(`No ${envName} set. Run: oneshot-gtm config llm`);
  }

  const expanded: LlmCompleteInput = { ...input, messages: injectHumanizer(input.messages) };

  switch (cfg.llmProvider) {
    case "openrouter":
      return openaiCompatibleComplete({
        key,
        model: cfg.llmModel,
        baseUrl: "https://openrouter.ai/api/v1",
        provider: "openrouter",
        input: expanded,
        extraHeaders: {
          "HTTP-Referer": "https://github.com/oneshot-agent/oneshot-gtm",
          "X-Title": "oneshot-gtm",
        },
      });
    case "openai":
      return openaiCompatibleComplete({
        key,
        model: cfg.llmModel,
        baseUrl: "https://api.openai.com/v1",
        provider: "openai",
        input: expanded,
      });
    case "anthropic":
      return anthropicComplete({ key, model: cfg.llmModel, input: expanded });
  }
}

interface OpenAIArgs {
  key: string;
  model: string;
  baseUrl: string;
  provider: string;
  input: LlmCompleteInput;
  extraHeaders?: Record<string, string>;
}

async function openaiCompatibleComplete(args: OpenAIArgs): Promise<LlmCompleteOutput> {
  const res = await fetch(`${args.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${args.key}`,
      ...args.extraHeaders,
    },
    body: JSON.stringify({
      model: args.model,
      messages: args.input.messages,
      temperature: args.input.temperature ?? 0.7,
      max_tokens: args.input.maxTokens ?? 1024,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new LlmError(`${args.provider} ${res.status}: ${body.slice(0, 400)}`, res.status);
  }

  const data = (await res.json()) as {
    choices: Array<{ message: { content: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };

  const choice = data.choices[0];
  if (!choice) throw new LlmError(`${args.provider} returned no choices`);

  return {
    content: choice.message.content,
    provider: args.provider,
    model: args.model,
    inputTokens: data.usage?.prompt_tokens,
    outputTokens: data.usage?.completion_tokens,
  };
}

interface AnthropicArgs {
  key: string;
  model: string;
  input: LlmCompleteInput;
}

async function anthropicComplete(args: AnthropicArgs): Promise<LlmCompleteOutput> {
  const system = args.input.messages.find((m) => m.role === "system")?.content;
  const messages = args.input.messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role, content: m.content }));

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": args.key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: args.model,
      max_tokens: args.input.maxTokens ?? 1024,
      temperature: args.input.temperature ?? 0.7,
      ...(system ? { system } : {}),
      messages,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new LlmError(`anthropic ${res.status}: ${body.slice(0, 400)}`, res.status);
  }

  const data = (await res.json()) as {
    content: Array<{ type: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };

  const text = data.content.map((b) => b.text ?? "").join("");
  return {
    content: text,
    provider: "anthropic",
    model: args.model,
    inputTokens: data.usage?.input_tokens,
    outputTokens: data.usage?.output_tokens,
  };
}
