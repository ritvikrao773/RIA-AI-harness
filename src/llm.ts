export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  name?: string;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
}

export class LLMClient {
  constructor(
    private baseURL: string,
    private apiKey: string,
  ) {}

  /** Stream a chat completion. Yields text deltas; returns tool calls + usage at end. */
  async chat(
    messages: ChatMessage[],
    tools: ToolDef[],
    onText?: (t: string) => void,
    signal?: AbortSignal,
  ): Promise<{ content: string; toolCalls: ToolCall[]; usage?: Usage }> {
    const body: Record<string, unknown> = {
      model: (this as unknown as { modelKey: string }).modelKey,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (tools.length) body.tools = tools.map((t) => ({ type: "function", function: t }));

    const res = await fetch(`${this.baseURL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      throw new Error(`API ${res.status}: ${text.slice(0, 500)}`);
    }

    let content = "";
    const toolCalls: ToolCall[] = [];
    let usage: Usage | undefined;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        let chunk: any;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }
        if (chunk.usage) usage = chunk.usage;
        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;
        if (delta.content) {
          content += delta.content;
          onText?.(delta.content);
        }
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const i = tc.index ?? 0;
            if (!toolCalls[i]) toolCalls[i] = { id: "", name: "", arguments: "" };
            if (tc.id) toolCalls[i].id = tc.id;
            if (tc.function?.name) toolCalls[i].name += tc.function.name;
            if (tc.function?.arguments) toolCalls[i].arguments += tc.function.arguments;
          }
        }
      }
    }
    return { content, toolCalls: toolCalls.filter(Boolean), usage };
  }
}

/** Client bound to a specific model id. */
export function bindModel(baseURL: string, apiKey: string, modelKey: string): LLMClient & { modelKey: string } {
  const c = new LLMClient(baseURL, apiKey) as LLMClient & { modelKey: string };
  c.modelKey = modelKey;
  return c;
}

export const estimateTokens = (s: string): number => Math.ceil(s.length / 4);
