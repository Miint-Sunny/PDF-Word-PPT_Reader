import { useState, useEffect, useRef, KeyboardEvent, CSSProperties } from 'react';
import './index.css';
import { DocumentViewer } from './components/DocumentViewer';
import type { DocumentViewerHandle } from './components/DocumentViewer';
import { AIAgent } from './lib/agent';
import type { ChatMsg, Provider, ProviderConfig } from './lib/agent';
import { extractTextFromPDF } from './lib/pdf';
import { open } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';

const DEFAULT_MODELS: Record<Provider, string> = {
  openai: 'gpt-4o-mini',
  gemini: 'gemini-2.5-flash',
  vertex: 'gemini-2.5-flash',
  local: 'Xenova/Qwen1.5-0.5B-Chat',
};

// Small helper for persisted string state (keys/config survive restarts).
// NOTE: localStorage is convenient but not a secure vault — the Vertex service
// account JSON in particular is sensitive. Fine for a local MVP; revisit later.
const persisted = (key: string, fallback: string) =>
  localStorage.getItem(key) ?? fallback;

function App() {
  const [filePath, setFilePath] = useState<string | null>(null);
  const [docText, setDocText] = useState<string>('');
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
  const [apiKey, setApiKey] = useState<string>(() => persisted('apiKey', ''));
  const [vertexProject, setVertexProject] = useState<string>(() => persisted('vertexProject', ''));
  const [vertexLocation, setVertexLocation] = useState<string>(
    () => persisted('vertexLocation', 'us-central1')
  );
  const [vertexSaJson, setVertexSaJson] = useState<string>(() => persisted('vertexSaJson', ''));

  // Persist config
  useEffect(() => {
    localStorage.setItem('provider', provider);
    localStorage.setItem('model', model);
    localStorage.setItem('apiKey', apiKey);
    localStorage.setItem('vertexProject', vertexProject);
    localStorage.setItem('vertexLocation', vertexLocation);
    localStorage.setItem('vertexSaJson', vertexSaJson);
  }, [provider, model, apiKey, vertexProject, vertexLocation, vertexSaJson]);

  const [chat1Msgs, setChat1Msgs] = useState<ChatMsg[]>([]);
  const [chat1Input, setChat1Input] = useState('');
  const [isChat1Loading, setIsChat1Loading] = useState(false);

  const [chat2Msgs, setChat2Msgs] = useState<ChatMsg[]>([]);
  const [chat2Input, setChat2Input] = useState('');
  const [isChat2Loading, setIsChat2Loading] = useState(false);

  const handleProviderChange = (p: Provider) => {
    setProvider(p);
    setModel(DEFAULT_MODELS[p]);
  };

  const handleOpenFile = async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: 'Documents', extensions: ['pdf', 'docx', 'pptx', 'doc', 'ppt'] }],
      });

      if (selected && typeof selected === 'string') {
        // Rust backend command to handle conversion for Office files
        const processedPath = await invoke<string>('convert_to_pdf_if_needed', {
          filePath: selected,
        });

        setFilePath(processedPath);
        setDocText('');

        // Read the file as a byte array
        const bufferArray = await invoke<number[]>('read_file_buffer', {
          filePath: processedPath,
        });
        const buffer = new Uint8Array(bufferArray);

        if (buffer) {
          const text = await extractTextFromPDF(buffer);
          setDocText(text);
        }
      }
    } catch (err: any) {
      console.error(err);
      alert(`Failed to open document: ${err.message || err}`);
    }
  };

  const getAgent = (): AIAgent | null => {
    if (provider === 'local') {
      // Offline, in-WebView model — no credentials needed.
      return new AIAgent({ provider, model, onProgress: setLocalStatus });
    }

    if (provider === 'vertex') {
      if (!vertexProject || !vertexLocation || !vertexSaJson) {
        alert('Vertex requires a project, location, and service account JSON.');
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
      alert(`Please enter your ${provider === 'openai' ? 'OpenAI' : 'Gemini'} API key first.`);
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

  const handleChat1Submit = async (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && chat1Input.trim()) {
      const agent = getAgent();
      if (!agent) return;

      const newMsgs: ChatMsg[] = [...chat1Msgs, buildUserMsg(chat1Input)];
      setChat1Msgs(newMsgs);
      setChat1Input('');
      setIsChat1Loading(true);

      try {
        const reply = await agent.askGlobalContext(newMsgs, docText);
        setChat1Msgs([...newMsgs, { role: 'assistant', content: reply }]);
      } catch (err: any) {
        setChat1Msgs([...newMsgs, { role: 'system', content: `Error: ${err.message || err}` }]);
      } finally {
        setIsChat1Loading(false);
      }
    }
  };

  const handleChat2Submit = async (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && chat2Input.trim()) {
      const agent = getAgent();
      if (!agent) return;

      const prompt = selectedText
        ? `Regarding the selected text: "${selectedText}"\n\n${chat2Input}`
        : chat2Input;

      const newMsgs: ChatMsg[] = [...chat2Msgs, buildUserMsg(prompt)];
      setChat2Msgs(newMsgs);
      setChat2Input('');
      setIsChat2Loading(true);

      try {
        const reply = await agent.askDetail(chat1Msgs, newMsgs, docText, selectedText);
        setChat2Msgs([...newMsgs, { role: 'assistant', content: reply }]);
      } catch (err: any) {
        setChat2Msgs([...newMsgs, { role: 'system', content: `Error: ${err.message || err}` }]);
      } finally {
        setIsChat2Loading(false);
      }
    }
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
                style={{ ...inputStyle, width: '220px' }}
                title="Paste the full service-account JSON key"
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
        <div
          className="pane-content"
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: filePath ? 'flex-start' : 'center',
          }}
        >
          {filePath ? (
            <DocumentViewer ref={viewerRef} filePath={filePath} onTextSelected={setSelectedText} />
          ) : (
            <p style={{ color: '#666' }}>No document opened</p>
          )}
        </div>
      </div>

      {/* Chat 1 Pane (Middle - 25%) */}
      <div className="chat-pane">
        <div className="pane-header">Chat 1 (Summary & Global)</div>
        <div className="pane-content" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <p style={{ fontSize: '0.8rem', color: '#888' }}>Ask for summaries and global context here.</p>
          {chat1Msgs.map((msg, i) => (
            <div
              key={i}
              style={{
                alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start',
                background: msg.role === 'user' ? '#0e639c' : '#333',
                padding: '8px',
                borderRadius: '6px',
                maxWidth: '90%',
                fontSize: '0.9rem',
                whiteSpace: 'pre-wrap',
              }}
            >
              <strong>{msg.role}: </strong> {msg.content}
            </div>
          ))}
          {isChat1Loading && <div style={{ fontSize: '0.8rem', color: '#888' }}>Thinking...</div>}
        </div>
        <div className="chat-input-container">
          <input
            type="text"
            className="chat-input"
            placeholder="Type a message and press Enter..."
            value={chat1Input}
            onChange={(e) => setChat1Input(e.target.value)}
            onKeyDown={handleChat1Submit}
            disabled={isChat1Loading}
          />
        </div>
      </div>

      {/* Chat 2 Pane (Right - 25%) */}
      <div className="chat-pane">
        <div className="pane-header">Chat 2 (Detail & Details)</div>
        <div className="pane-content" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <p style={{ fontSize: '0.8rem', color: '#888' }}>
            Ask detailed questions. Uses Chat 1 context and current text selection.
          </p>
          {chat2Msgs.map((msg, i) => (
            <div
              key={i}
              style={{
                alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start',
                background: msg.role === 'user' ? '#0e639c' : '#333',
                padding: '8px',
                borderRadius: '6px',
                maxWidth: '90%',
                fontSize: '0.9rem',
                whiteSpace: 'pre-wrap',
              }}
            >
              <strong>{msg.role}: </strong> {msg.content}
            </div>
          ))}
          {isChat2Loading && <div style={{ fontSize: '0.8rem', color: '#888' }}>Thinking...</div>}
        </div>
        <div className="chat-input-container">
          <input
            type="text"
            className="chat-input"
            placeholder="Ask about details and press Enter..."
            value={chat2Input}
            onChange={(e) => setChat2Input(e.target.value)}
            onKeyDown={handleChat2Submit}
            disabled={isChat2Loading}
          />
        </div>
      </div>
    </div>
  );
}

export default App;
