import { useState, useEffect, useRef, CSSProperties } from 'react';
import './index.css';
import { DocumentViewer } from './components/DocumentViewer';
import type { DocumentViewerHandle } from './components/DocumentViewer';
import { ChatPane } from './components/ChatPane';
import { AIAgent, cancelLlm } from './lib/agent';
import type { ChatMsg, Provider, ProviderConfig } from './lib/agent';
import { secretGet, secretSet, secretDelete } from './lib/secrets';
import { extractTextFromPDF } from './lib/pdf';
import { open } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebview } from '@tauri-apps/api/webview';

const OPENABLE = /\.(pdf|docx?|pptx?)$/i;

const DEFAULT_MODELS: Record<Provider, string> = {
  openai: 'gpt-4o-mini',
  gemini: 'gemini-2.5-flash',
  vertex: 'gemini-2.5-flash',
  local: 'Xenova/Qwen1.5-0.5B-Chat',
};

// Small helper for persisted string state (non-secret config only).
const persisted = (key: string, fallback: string) =>
  localStorage.getItem(key) ?? fallback;

const chatStorageKey = (fp: string | null) => `chats:${fp ?? 'none'}`;

// Persist at most the last 100 messages, without base64 images (size).
const stripForStorage = (ms: ChatMsg[]) =>
  ms.slice(-100).map(({ images: _images, ...rest }) => rest);

function App() {
  const [filePath, setFilePath] = useState<string | null>(null);
  const [docText, setDocText] = useState<string>('');
  const [docLoading, setDocLoading] = useState<string>('');
  const [selectedText, setSelectedText] = useState<string>('');

  // Vision: when enabled, attach the currently-visible page image to outgoing
  // messages so multimodal models (Gemini, gpt-4o) can see figures/charts.
  const viewerRef = useRef<DocumentViewerHandle>(null);
  const [visionEnabled, setVisionEnabled] = useState<boolean>(false);

  // Local (offline) model load/generation status.
  const [localStatus, setLocalStatus] = useState<string>('');

  // Provider configuration
  const [provider, setProvider] = useState<Provider>(
    () => (persisted('provider', 'openai') as Provider)
  );
  const [model, setModel] = useState<string>(() => persisted('model', DEFAULT_MODELS.openai));
  const [vertexProject, setVertexProject] = useState<string>(() => persisted('vertexProject', ''));
  const [vertexLocation, setVertexLocation] = useState<string>(
    () => persisted('vertexLocation', 'us-central1')
  );
  // Secrets (apiKey per provider, vertexSaJson) live in the OS keychain, loaded async below.
  const [apiKey, setApiKey] = useState<string>('');
  const [vertexSaJson, setVertexSaJson] = useState<string>('');

  // Persist NON-secret config only. Keys/creds go to the keychain, never here.
  useEffect(() => {
    localStorage.setItem('provider', provider);
    localStorage.setItem('model', model);
    localStorage.setItem('vertexProject', vertexProject);
    localStorage.setItem('vertexLocation', vertexLocation);
  }, [provider, model, vertexProject, vertexLocation]);

  // One-time migration: purge any secrets previously stored in localStorage plaintext.
  useEffect(() => {
    for (const stale of ['apiKey', 'vertexSaJson']) localStorage.removeItem(stale);
  }, []);

  // Load the current provider's API key from the keychain (openai/gemini).
  useEffect(() => {
    if (provider !== 'openai' && provider !== 'gemini') return;
    let cancelled = false;
    secretGet(`api_key_${provider}`)
      .then((v) => {
        if (!cancelled) setApiKey(v ?? '');
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [provider]);

  // Load the Vertex service-account JSON from the keychain once.
  useEffect(() => {
    secretGet('vertex_sa_json')
      .then((v) => setVertexSaJson(v ?? ''))
      .catch(() => {});
  }, []);

  // Save helpers (called on blur to avoid keychain churn on every keystroke).
  const saveApiKey = () => {
    if (provider !== 'openai' && provider !== 'gemini') return;
    const k = `api_key_${provider}`;
    if (apiKey) secretSet(k, apiKey).catch(() => {});
    else secretDelete(k).catch(() => {});
  };
  const saveVertexSaJson = () => {
    if (vertexSaJson) secretSet('vertex_sa_json', vertexSaJson).catch(() => {});
    else secretDelete('vertex_sa_json').catch(() => {});
  };

  // ---- Chat state (persisted per document) ------------------------------
  const [chat1Msgs, setChat1Msgs] = useState<ChatMsg[]>([]);
  const [isChat1Loading, setIsChat1Loading] = useState(false);
  const chat1Req = useRef<string | null>(null);

  const [chat2Msgs, setChat2Msgs] = useState<ChatMsg[]>([]);
  const [isChat2Loading, setIsChat2Loading] = useState(false);
  const chat2Req = useRef<string | null>(null);

  // Guards the save effect so a document switch can't clobber the new
  // document's history with the previous one's messages.
  const chatsLoadedFor = useRef<string | null | undefined>(undefined);

  // SAVE (declared before LOAD on purpose — on a filePath change this runs
  // first with the stale loadedFor and skips, then LOAD re-points it).
  useEffect(() => {
    if (chatsLoadedFor.current !== filePath) return;
    try {
      localStorage.setItem(
        chatStorageKey(filePath),
        JSON.stringify({ chat1: stripForStorage(chat1Msgs), chat2: stripForStorage(chat2Msgs) })
      );
    } catch {
      /* storage full — skip */
    }
  }, [chat1Msgs, chat2Msgs, filePath]);

  // LOAD chat history for the current document.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(chatStorageKey(filePath));
      const saved = raw ? JSON.parse(raw) : null;
      setChat1Msgs(Array.isArray(saved?.chat1) ? saved.chat1 : []);
      setChat2Msgs(Array.isArray(saved?.chat2) ? saved.chat2 : []);
    } catch {
      setChat1Msgs([]);
      setChat2Msgs([]);
    }
    chatsLoadedFor.current = filePath;
  }, [filePath]);

  // ---- Document open -----------------------------------------------------
  const openPath = async (path: string) => {
    setDocLoading('正在转换 / 加载文档…');
    try {
      // Rust backend command to handle conversion for Office files
      const processedPath = await invoke<string>('convert_to_pdf_if_needed', { filePath: path });
      setFilePath(processedPath);
      setDocText('');
      setSelectedText('');

      // Raw bytes come back as an ArrayBuffer (binary IPC).
      const buffer = await invoke<ArrayBuffer>('read_file_buffer', { filePath: processedPath });
      const text = await extractTextFromPDF(new Uint8Array(buffer));
      setDocText(text);
    } catch (err: any) {
      console.error(err);
      alert(`打开文档失败: ${err.message || err}`);
    } finally {
      setDocLoading('');
    }
  };

  const handleOpenFile = async () => {
    const selected = await open({
      multiple: false,
      filters: [{ name: 'Documents', extensions: ['pdf', 'docx', 'pptx', 'doc', 'ppt'] }],
    });
    if (selected && typeof selected === 'string') {
      await openPath(selected);
    }
  };

  // Drag & drop a document anywhere onto the window to open it.
  const [dragging, setDragging] = useState(false);
  const openPathRef = useRef(openPath);
  openPathRef.current = openPath;
  useEffect(() => {
    const unlistenPromise = getCurrentWebview().onDragDropEvent((event) => {
      const t = event.payload.type;
      if (t === 'enter' || t === 'over') setDragging(true);
      else setDragging(false);
      if (t === 'drop') {
        const path = event.payload.paths.find((p) => OPENABLE.test(p));
        if (path) void openPathRef.current(path);
      }
    });
    return () => {
      void unlistenPromise.then((un) => un());
    };
  }, []);

  // ---- Agent -------------------------------------------------------------
  const getAgent = (): AIAgent | null => {
    if (provider === 'local') {
      // Offline, in-WebView model — no credentials needed.
      return new AIAgent({ provider, model, onProgress: setLocalStatus });
    }

    if (provider === 'vertex') {
      if (!vertexProject || !vertexLocation || !vertexSaJson) {
        alert('Vertex 需要填写 GCP Project、Location 和服务账号 JSON。');
        return null;
      }
      const config: ProviderConfig = {
        provider,
        model,
        vertex: {
          project: vertexProject,
          location: vertexLocation,
          serviceAccountJson: vertexSaJson,
        },
      };
      return new AIAgent(config);
    }

    if (!apiKey) {
      alert(`请先填写 ${provider === 'openai' ? 'OpenAI' : 'Gemini'} API Key。`);
      return null;
    }
    return new AIAgent({ provider, model, apiKey });
  };

  // Build a user message, attaching the visible page image when vision is on.
  const buildUserMsg = (content: string): ChatMsg => {
    const msg: ChatMsg = { role: 'user', content };
    if (visionEnabled && filePath) {
      const img = viewerRef.current?.captureVisiblePage();
      if (img) msg.images = [img];
    }
    return msg;
  };

  // Append a streaming delta to the trailing assistant message.
  const appendDelta = (setMsgs: React.Dispatch<React.SetStateAction<ChatMsg[]>>) => (d: string) =>
    setMsgs((prev) => {
      const last = prev[prev.length - 1];
      if (!last || last.role !== 'assistant') return prev;
      return [...prev.slice(0, -1), { ...last, content: last.content + d }];
    });

  const sendChat1 = async (text: string) => {
    const agent = getAgent();
    if (!agent) return;

    const base: ChatMsg[] = [...chat1Msgs, buildUserMsg(text)];
    setChat1Msgs([...base, { role: 'assistant', content: '' }]);
    setIsChat1Loading(true);
    const requestId = crypto.randomUUID();
    chat1Req.current = requestId;

    try {
      const reply = await agent.askGlobalContext(base, docText, {
        requestId,
        onDelta: appendDelta(setChat1Msgs),
      });
      setChat1Msgs([...base, { role: 'assistant', content: reply }]);
    } catch (err: any) {
      setChat1Msgs([...base, { role: 'system', content: `Error: ${err.message || err}` }]);
    } finally {
      setIsChat1Loading(false);
      chat1Req.current = null;
    }
  };

  const sendChat2 = async (text: string) => {
    const agent = getAgent();
    if (!agent) return;

    const prompt = selectedText
      ? `Regarding the selected text: "${selectedText}"\n\n${text}`
      : text;

    const base: ChatMsg[] = [...chat2Msgs, buildUserMsg(prompt)];
    setChat2Msgs([...base, { role: 'assistant', content: '' }]);
    setIsChat2Loading(true);
    const requestId = crypto.randomUUID();
    chat2Req.current = requestId;

    try {
      const reply = await agent.askDetail(chat1Msgs, base, docText, selectedText, {
        requestId,
        onDelta: appendDelta(setChat2Msgs),
      });
      setChat2Msgs([...base, { role: 'assistant', content: reply }]);
    } catch (err: any) {
      setChat2Msgs([...base, { role: 'system', content: `Error: ${err.message || err}` }]);
    } finally {
      setIsChat2Loading(false);
      chat2Req.current = null;
    }
  };

  const stopChat1 = () => {
    if (chat1Req.current) cancelLlm(chat1Req.current).catch(() => {});
  };
  const stopChat2 = () => {
    if (chat2Req.current) cancelLlm(chat2Req.current).catch(() => {});
  };

  const inputStyle: CSSProperties = {
    padding: '5px',
    borderRadius: '3px',
    border: '1px solid #555',
    background: '#222',
    color: 'white',
  };

  return (
    <div className="app-container">
      {/* Document Pane (Left - 50%) */}
      <div className="document-pane">
        <div className="pane-header">Document Viewer</div>
        <div className="toolbar" style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
            <button onClick={handleOpenFile}>Open PDF/Word/PPT</button>

            <select
              value={provider}
              onChange={(e) => handleProviderChange(e.target.value as Provider)}
              style={inputStyle}
              title="Model provider"
            >
              <option value="openai">OpenAI</option>
              <option value="gemini">Gemini API</option>
              <option value="vertex">Vertex AI</option>
              <option value="local">Local (offline)</option>
            </select>

            <input
              type="text"
              placeholder="Model"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              style={{ ...inputStyle, width: '150px' }}
              title="Model id"
            />

            {(provider === 'openai' || provider === 'gemini') && (
              <input
                type="password"
                placeholder={provider === 'openai' ? 'OpenAI API Key' : 'Gemini API Key'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                onBlur={saveApiKey}
                style={{ ...inputStyle, width: '200px' }}
              />
            )}

            <label
              style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '0.8rem', color: '#ccc' }}
              title="Attach the current page as an image so vision-capable models (Gemini, gpt-4o) can see figures & charts"
            >
              <input
                type="checkbox"
                checked={visionEnabled}
                onChange={(e) => setVisionEnabled(e.target.checked)}
                disabled={!filePath}
              />
              🖼 Vision
            </label>
          </div>

          {provider === 'vertex' && (
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
              <input
                type="text"
                placeholder="GCP Project ID"
                value={vertexProject}
                onChange={(e) => setVertexProject(e.target.value)}
                style={{ ...inputStyle, width: '160px' }}
              />
              <input
                type="text"
                placeholder="Location (e.g. us-central1)"
                value={vertexLocation}
                onChange={(e) => setVertexLocation(e.target.value)}
                style={{ ...inputStyle, width: '160px' }}
              />
              <input
                type="password"
                placeholder="Service Account JSON"
                value={vertexSaJson}
                onChange={(e) => setVertexSaJson(e.target.value)}
                onBlur={saveVertexSaJson}
                style={{ ...inputStyle, width: '220px' }}
                title="Paste the full service-account JSON key (stored in the OS keychain)"
              />
            </div>
          )}

          {provider === 'local' && (
            <div style={{ fontSize: '0.75rem', color: '#e0a94a' }}>
              {localStatus
                ? `Local model: ${localStatus}`
                : 'Local (offline) model — first run downloads weights; small context & modest quality.'}
            </div>
          )}

          {selectedText && (
            <div style={{ fontSize: '0.8rem', background: '#3c3c3c', padding: '5px', borderRadius: '4px' }}>
              <strong>Selected:</strong>{' '}
              {selectedText.length > 50 ? selectedText.substring(0, 50) + '...' : selectedText}
            </div>
          )}
        </div>
        <div className="pane-content doc-host">
          {docLoading ? (
            <p className="doc-empty">{docLoading}</p>
          ) : filePath ? (
            <DocumentViewer ref={viewerRef} filePath={filePath} onTextSelected={setSelectedText} />
          ) : (
            <p className="doc-empty">未打开文档 — 点击上方按钮或将文件拖入窗口</p>
          )}
          {dragging && <div className="drop-overlay">松开以打开文档</div>}
        </div>
      </div>

      <ChatPane
        title="Chat 1 · 全局摘要"
        hint="在这里询问文档的整体内容、摘要与结构。"
        placeholder="输入问题,回车发送…"
        msgs={chat1Msgs}
        loading={isChat1Loading}
        statusLine={provider === 'local' && isChat1Loading ? localStatus : undefined}
        onSend={sendChat1}
        onStop={stopChat1}
        onClear={() => setChat1Msgs([])}
      />

      <ChatPane
        title="Chat 2 · 细节追问"
        hint="针对细节深入追问;会携带 Chat 1 的上下文与当前选中文本。"
        placeholder="追问细节,回车发送…"
        msgs={chat2Msgs}
        loading={isChat2Loading}
        statusLine={provider === 'local' && isChat2Loading ? localStatus : undefined}
        onSend={sendChat2}
        onStop={stopChat2}
        onClear={() => setChat2Msgs([])}
      />
    </div>
  );

  function handleProviderChange(p: Provider) {
    setProvider(p);
    setModel(DEFAULT_MODELS[p]);
  }
}

export default App;
