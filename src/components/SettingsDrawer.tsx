import { X, Sun, Moon } from 'lucide-react';
import type { Provider } from '../lib/agent';

export interface SettingsDrawerProps {
  open: boolean;
  onClose: () => void;
  provider: Provider;
  onProviderChange: (p: Provider) => void;
  model: string;
  setModel: (m: string) => void;
  apiKey: string;
  setApiKey: (k: string) => void;
  onApiKeyBlur: () => void;
  vertexProject: string;
  setVertexProject: (v: string) => void;
  vertexLocation: string;
  setVertexLocation: (v: string) => void;
  vertexSaJson: string;
  setVertexSaJson: (v: string) => void;
  onVertexSaJsonBlur: () => void;
  theme: string;
  setTheme: (t: string) => void;
  localStatus: string;
}

const PROVIDER_LABELS: Record<Provider, string> = {
  openai: 'OpenAI',
  gemini: 'Gemini API',
  vertex: 'Vertex AI',
  local: '本地模型 (离线)',
};

export function SettingsDrawer(props: SettingsDrawerProps) {
  const {
    open,
    onClose,
    provider,
    onProviderChange,
    model,
    setModel,
    apiKey,
    setApiKey,
    onApiKeyBlur,
    vertexProject,
    setVertexProject,
    vertexLocation,
    setVertexLocation,
    vertexSaJson,
    setVertexSaJson,
    onVertexSaJsonBlur,
    theme,
    setTheme,
    localStatus,
  } = props;

  if (!open) return null;

  return (
    <>
      <div className="drawer-overlay" onClick={onClose} />
      <aside className="drawer">
        <div className="drawer-header">
          <span>设置</span>
          <button className="icon-btn" title="关闭" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="drawer-body">
          <div className="drawer-section">
            <div className="drawer-section-title">模型</div>
            <div className="field">
              <label>提供方</label>
              <select value={provider} onChange={(e) => onProviderChange(e.target.value as Provider)}>
                {(Object.keys(PROVIDER_LABELS) as Provider[]).map((p) => (
                  <option key={p} value={p}>
                    {PROVIDER_LABELS[p]}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>模型 ID</label>
              <input value={model} onChange={(e) => setModel(e.target.value)} spellCheck={false} />
            </div>

            {(provider === 'openai' || provider === 'gemini') && (
              <div className="field">
                <label>{provider === 'openai' ? 'OpenAI API Key' : 'Gemini API Key'}</label>
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  onBlur={onApiKeyBlur}
                  placeholder="存储在系统钥匙串"
                />
                <div className="field-hint">密钥保存在操作系统钥匙串,不落明文。</div>
              </div>
            )}

            {provider === 'vertex' && (
              <>
                <div className="field">
                  <label>GCP Project ID</label>
                  <input value={vertexProject} onChange={(e) => setVertexProject(e.target.value)} spellCheck={false} />
                </div>
                <div className="field">
                  <label>Location</label>
                  <input
                    value={vertexLocation}
                    onChange={(e) => setVertexLocation(e.target.value)}
                    placeholder="us-central1"
                    spellCheck={false}
                  />
                </div>
                <div className="field">
                  <label>服务账号 JSON</label>
                  <textarea
                    rows={4}
                    value={vertexSaJson}
                    onChange={(e) => setVertexSaJson(e.target.value)}
                    onBlur={onVertexSaJsonBlur}
                    placeholder='{"type":"service_account", …}'
                    spellCheck={false}
                  />
                  <div className="field-hint">整段粘贴服务账号密钥 JSON;保存在系统钥匙串。</div>
                </div>
              </>
            )}

            {provider === 'local' && (
              <div className="field-hint">
                本地模型完全离线运行于本机(Transformers.js)。首次使用会下载权重;
                上下文窗口小、质量有限,适合隐私/离线场景。
                {localStatus && <div className="status-line">{localStatus}</div>}
              </div>
            )}
          </div>

          <div className="drawer-section">
            <div className="drawer-section-title">外观</div>
            <div className="switch-row">
              <span className="switch-label">
                主题
                <span className="switch-desc">{theme === 'dark' ? '暗色' : '亮色'}</span>
              </span>
              <button
                className="icon-btn on"
                title="切换主题"
                onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              >
                {theme === 'dark' ? <Moon size={16} /> : <Sun size={16} />}
              </button>
            </div>
          </div>
        </div>
      </aside>
    </>
  );
}
