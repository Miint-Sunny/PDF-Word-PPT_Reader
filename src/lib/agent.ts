import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage, AIMessage } from "@langchain/core/messages";

// Configuration interface
export interface AgentConfig {
  apiKey: string;
  baseUrl?: string;
  model: string;
}

// Message type for our UI
export interface ChatMsg {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export class AIAgent {
  private llm: ChatOpenAI;

  constructor(config: AgentConfig) {
    this.llm = new ChatOpenAI({
      openAIApiKey: config.apiKey,
      configuration: {
        baseURL: config.baseUrl,
      },
      modelName: config.model,
      temperature: 0.2, // Keep it objective and analytical based on persona
    });
  }

  // Convert generic messages to LangChain messages
  private convertMessages(messages: ChatMsg[]) {
    return messages.map(m => {
      if (m.role === 'user') return new HumanMessage(m.content);
      if (m.role === 'system') return new SystemMessage(m.content);
      return new AIMessage(m.content);
    });
  }

  // Ask Chat 1 (Summary/Global context)
  async askGlobalContext(messages: ChatMsg[], documentText: string): Promise<string> {
    const systemPrompt = `You are a rigorous, objective, professional, and reliable document assistant. 
Your core task is to provide correct conclusions, clear logic, verifiable evidence, complete analysis, and executable plans.
Do not use emotional language, emojis, or meaningless praise.

DOCUMENT CONTEXT:
---
${documentText.substring(0, 50000)} // Truncating to avoid massive token costs initially
---

Answer the user's questions based primarily on the document context provided above.`;

    const langMessages = [
      new SystemMessage(systemPrompt),
      ...this.convertMessages(messages)
    ];

    const res = await this.llm.invoke(langMessages);
    return res.content as string;
  }

  // Ask Chat 2 (Detailed question, inherits Chat 1 context)
  async askDetail(chat1Messages: ChatMsg[], chat2Messages: ChatMsg[], documentText: string, selectedText: string = ""): Promise<string> {
    
    let contextStr = `DOCUMENT CONTEXT:\n---\n${documentText.substring(0, 50000)}\n---\n`;
    if (selectedText) {
      contextStr += `\nUSER SELECTED TEXT FROM DOCUMENT:\n---\n${selectedText}\n---\nFocus your analysis specifically on this selection.\n`;
    }

    const systemPrompt = `You are a rigorous and professional document analysis assistant.
You are engaged in a detailed follow-up conversation. You have access to the global summary conversation history (Chat 1) and the current document.

${contextStr}

Maintain your analytical and objective persona.`;

    // Flatten chat 1 as context for chat 2, but clearly mark it
    const chat1ContextStr = chat1Messages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n');
    
    const augmentedChat2Messages: ChatMsg[] = [
      { role: 'system', content: `${systemPrompt}\n\nPREVIOUS GLOBAL CONVERSATION HISTORY:\n${chat1ContextStr}` },
      ...chat2Messages
    ];

    const langMessages = this.convertMessages(augmentedChat2Messages);
    
    const res = await this.llm.invoke(langMessages);
    return res.content as string;
  }
}
