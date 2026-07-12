// Local RAG for long documents: chunk → embed (Transformers.js MiniLM, fully
// on-device, no cloud quota) → cosine retrieve top chunks per question.
// Replaces blind 50k-char truncation when enabled. The embedding model
// (~25MB) downloads on first use; everything else is local compute.
import type { ProgressFn } from './local';

const EMBED_MODEL = 'Xenova/all-MiniLM-L6-v2';
const CHUNK_SIZE = 700;
const CHUNK_OVERLAP = 120;
const TOP_K = 8;

// Below this, just send the whole text — retrieval would only lose context.
export const RAG_MIN_DOC_CHARS = 20000;

let embedderPromise: Promise<any> | null = null;

async function getEmbedder(onProgress?: ProgressFn): Promise<any> {
  if (!embedderPromise) {
    embedderPromise = (async () => {
      const { pipeline } = await import('@xenova/transformers');
      onProgress?.('正在加载本地嵌入模型…');
      return pipeline('feature-extraction', EMBED_MODEL, {
        progress_callback: (p: any) => {
          if (p?.status === 'progress' && p?.file) {
            onProgress?.(`下载嵌入模型 ${p.file}: ${Math.round(p.progress ?? 0)}%`);
          }
        },
      });
    })().catch((e) => {
      embedderPromise = null; // allow retry after a failed download
      throw e;
    });
  }
  return embedderPromise;
}

// Char-window chunking, preferring paragraph/sentence boundaries near the cut.
export function chunkText(text: string): string[] {
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(text.length, i + CHUNK_SIZE);
    if (end < text.length) {
      const slice = text.slice(i, end);
      const cut = Math.max(
        slice.lastIndexOf('\n'),
        slice.lastIndexOf('。'),
        slice.lastIndexOf('. ')
      );
      if (cut > CHUNK_SIZE * 0.5) end = i + cut + 1;
    }
    const chunk = text.slice(i, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= text.length) break;
    i = end - CHUNK_OVERLAP;
  }
  return chunks;
}

export interface RagIndex {
  chunks: string[];
  vectors: Float32Array[];
}

async function embedOne(embedder: any, text: string): Promise<Float32Array> {
  const r = await embedder(text, { pooling: 'mean', normalize: true });
  return new Float32Array(r.data);
}

export async function buildRagIndex(docText: string, onProgress?: ProgressFn): Promise<RagIndex> {
  const embedder = await getEmbedder(onProgress);
  const chunks = chunkText(docText);
  const vectors: Float32Array[] = [];
  for (let i = 0; i < chunks.length; i++) {
    vectors.push(await embedOne(embedder, chunks[i]));
    if (i % 5 === 0 || i === chunks.length - 1) {
      onProgress?.(`正在建立本地检索索引… ${i + 1}/${chunks.length}`);
    }
  }
  onProgress?.('');
  return { chunks, vectors };
}

// Vectors are normalized, so dot product == cosine similarity.
export async function ragRetrieve(
  index: RagIndex,
  query: string,
  onProgress?: ProgressFn
): Promise<string> {
  const embedder = await getEmbedder(onProgress);
  const qv = await embedOne(embedder, query);
  const scored = index.vectors.map((v, i) => {
    let s = 0;
    for (let j = 0; j < v.length; j++) s += v[j] * qv[j];
    return { i, s };
  });
  scored.sort((a, b) => b.s - a.s);
  // Present the winners in document order so the excerpt reads coherently.
  const picked = scored
    .slice(0, TOP_K)
    .map((x) => x.i)
    .sort((a, b) => a - b);
  return picked.map((i) => index.chunks[i]).join('\n\n……\n\n');
}
