import { invoke } from '@tauri-apps/api/core';

// Supported model providers. "Antigravity" is intentionally absent — it has no
// embeddable third-party API (it is an agentic IDE / the CORS-blocked
// Interactions API), so Google Cloud is served by Gemini API + Vertex AI.
export type Provider = 'openai' | 'gemini' | 'vertex';

// Optional multimodal image part (base64, no data: prefix). Wired through the
// backend so Gemini's native vision can later analyze PPT images/charts.
export interface ImagePart {
  mimeType: string;
  data: string;
}

// Message type for our UI
export interface ChatMsg {
  role: 'user' | 'assistant' | 'system';
  content: string;
  images?: ImagePart[];
}

export interface VertexCreds {
  project: string;
  location: string;
  serviceAccountJson: string;
}

export interface ProviderConfig {
  provider: Provider;
  model: string;
  apiKey?: string; // openai / gemini
  baseUrl?: string; // optional OpenAI-compatible endpoint override
  vertex?: VertexCreds; // vertex only
}

// Mirrors the Rust `LlmRequest` (camelCase) consumed by the `llm_chat` command.
interface LlmRequest {
  provider: Provider;
  model: string;
  system: string;
  messages: ChatMsg[];
  apiKey?: string;
  baseUrl?: string;
  vertex?: VertexCreds;
}

// Truncate document context to keep token costs bounded.
const DOC_CONTEXT_LIMIT = 50000;

export class AIAgent {
  private config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  // All network calls happen in Rust (bypasses WebView CORS + keeps keys/creds
  // out of the JS bundle). This just marshals the request.
  private async chat(system: string, messages: ChatMsg[]): Promise<string> {
    const req: LlmRequest = {
      provider: this.config.provider,
      model: this.config.model,
      system,
      messages,
      apiKey: this.config.apiKey,
      baseUrl: this.config.baseUrl,
      vertex: this.config.vertex,
    };
    return await invoke<string>('llm_chat', { req });
  }

  // Chat 1 — summary / global context.
  async askGlobalContext(messages: ChatMsg[], documentText: string): Promise<string> {
    const system = `You are a rigorous, objective, professional, and reliable document assistant.
Your core task is to provide correct conclusions, clear logic, verifiable evidence, complete analysis, and executable plans.
Do not use emotional language, emojis, or meaningless praise.

DOCUMENT CONTEXT:
---
${documentText.substring(0, DOC_CONTEXT_LIMIT)}
---

Answer the user's questions based primarily on the document context provided above.`;

    return this.chat(system, messages);
  }

  // Chat 2 — detailed follow-up; inherits Chat 1 history + the current selection.
  async askDetail(
    chat1Messages: ChatMsg[],
    chat2Messages: ChatMsg[],
    documentText: string,
    selectedText: string = ''
  ): Promise<string> {
    let contextStr = `DOCUMENT CONTEXT:\n---\n${documentText.substring(0, DOC_CONTEXT_LIMIT)}\n---\n`;
    if (selectedText) {
      contextStr += `\nUSER SELECTED TEXT FROM DOCUMENT:\n---\n${selectedText}\n---\nFocus your analysis specifically on this selection.\n`;
    }

    const chat1ContextStr = chat1Messages
      .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
      .join('\n\n');

    const system = `You are a rigorous and professional document analysis assistant.
You are engaged in a detailed follow-up conversation. You have access to the global summary conversation history (Chat 1) and the current document.

${contextStr}

Maintain your analytical and objective persona.

PREVIOUS GLOBAL CONVERSATION HISTORY (Chat 1):
${chat1ContextStr}`;

    return this.chat(system, chat2Messages);
  }
}
