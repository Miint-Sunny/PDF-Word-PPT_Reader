// On-device (offline) inference via Transformers.js, running entirely inside the
// WebView — no API keys, no network after the model is cached. This is the
// "local" provider in the agent's provider abstraction. Small local models have
// tiny context windows and modest quality, so it's best treated as an offline
// fallback / privacy option rather than a match for the cloud providers.
import type { ChatMsg } from './agent';

export type ProgressFn = (msg: string) => void;

// Lazily-loaded, cached pipeline (keyed by model id).
let cachedModelId: string | null = null;
let cachedGenerator: any = null;
let loadingPromise: Promise<any> | null = null;

// Tiny local models have small context windows — keep the injected doc context
// far smaller than the cloud providers' 50k.
const LOCAL_SYSTEM_LIMIT = 4000;
const MAX_NEW_TOKENS = 512;

async function getGenerator(modelId: string, onProgress?: ProgressFn): Promise<any> {
  if (cachedGenerator && cachedModelId === modelId) return cachedGenerator;
  // Different model requested (or first load) — (re)initialize.
  if (loadingPromise && cachedModelId === modelId) return loadingPromise;

  loadingPromise = (async () => {
    const { pipeline } = await import('@xenova/transformers');
    onProgress?.(`Loading ${modelId} (first run downloads the model)…`);
    const generator = await pipeline('text-generation', modelId, {
      progress_callback: (p: any) => {
        if (p?.status === 'progress' && p?.file) {
          onProgress?.(`Downloading ${p.file}: ${Math.round(p.progress ?? 0)}%`);
        } else if (p?.status && p.status !== 'progress') {
          onProgress?.(`${p.status}${p.file ? ' ' + p.file : ''}`);
        }
      },
    });
    cachedGenerator = generator;
    cachedModelId = modelId;
    onProgress?.('Model ready.');
    return generator;
  })();

  try {
    return await loadingPromise;
  } finally {
    loadingPromise = null;
  }
}

export async function localChat(
  modelId: string,
  system: string,
  messages: ChatMsg[],
  onProgress?: ProgressFn
): Promise<string> {
  const generator = await getGenerator(modelId, onProgress);

  const sys =
    system.length > LOCAL_SYSTEM_LIMIT
      ? system.slice(0, LOCAL_SYSTEM_LIMIT) + '\n...[context truncated for local model]'
      : system;

  // Text-only: local models here don't take images.
  const chatMessages = [
    { role: 'system', content: sys },
    ...messages.map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user',
      content: m.content,
    })),
  ];

  // Prefer the model's chat template; fall back to a plain transcript.
  let prompt: string;
  try {
    prompt = generator.tokenizer.apply_chat_template(chatMessages, {
      tokenize: false,
      add_generation_prompt: true,
    }) as string;
  } catch {
    prompt =
      chatMessages.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n') +
      '\n\nASSISTANT:';
  }

  onProgress?.('Generating…');
  const output: any = await generator(prompt, {
    max_new_tokens: MAX_NEW_TOKENS,
    temperature: 0.2,
    do_sample: false,
    return_full_text: false,
  });

  let text: string =
    (Array.isArray(output) ? output[0]?.generated_text : output?.generated_text) ?? '';
  // Safety strip in case return_full_text was ignored by the backend.
  if (text.startsWith(prompt)) text = text.slice(prompt.length);
  onProgress?.('');
  return String(text).trim();
}
