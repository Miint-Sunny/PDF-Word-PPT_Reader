import {
  useEffect,
  useRef,
  useState,
  forwardRef,
  useImperativeHandle,
  KeyboardEvent,
} from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Copy, Check, Trash2, Square, Send, Download } from 'lucide-react';
import type { ChatMsg } from '../lib/agent';

interface ChatPaneProps {
  title: string;
  hint: string;
  placeholder: string;
  msgs: ChatMsg[];
  loading: boolean;
  statusLine?: string; // e.g. local model download progress
  onSend: (text: string) => void;
  onStop: () => void;
  onClear: () => void;
  onExport?: () => void;
}

export interface ChatPaneHandle {
  focus: () => void;
}

// One chat column: header (title + actions), scrolling message list, input row.
export const ChatPane = forwardRef<ChatPaneHandle, ChatPaneProps>(function ChatPane(
  { title, hint, placeholder, msgs, loading, statusLine, onSend, onStop, onClear, onExport },
  ref
) {
  const [input, setInput] = useState('');
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const stickToBottom = useRef(true);

  useImperativeHandle(ref, () => ({
    focus: () => inputRef.current?.focus(),
  }));

  // Track whether the user has scrolled away from the bottom; only auto-scroll
  // while they're at (or near) the bottom so reading back isn't hijacked.
  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [msgs, loading]);

  const submit = () => {
    const text = input.trim();
    if (!text || loading) return;
    setInput('');
    stickToBottom.current = true;
    onSend(text);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') submit();
  };

  const copyMsg = async (content: string, idx: number) => {
    try {
      await navigator.clipboard.writeText(content);
      setCopiedIdx(idx);
      setTimeout(() => setCopiedIdx((c) => (c === idx ? null : c)), 1200);
    } catch {
      /* clipboard unavailable */
    }
  };

  const lastIdx = msgs.length - 1;
  const streamingEmpty =
    loading && msgs[lastIdx]?.role === 'assistant' && msgs[lastIdx].content === '';

  return (
    <div className="chat-pane-inner">
      <div className="pane-header">
        <span className="pane-title">{title}</span>
        <span className="pane-actions">
          {onExport && (
            <button
              className="icon-btn"
              title="导出对话 (Markdown)"
              onClick={onExport}
              disabled={msgs.length === 0}
            >
              <Download size={14} />
            </button>
          )}
          <button
            className="icon-btn"
            title="清空对话"
            onClick={onClear}
            disabled={loading || msgs.length === 0}
          >
            <Trash2 size={14} />
          </button>
        </span>
      </div>

      <div className="pane-content chat-scroll" ref={scrollRef} onScroll={handleScroll}>
        {msgs.length === 0 && <p className="chat-hint">{hint}</p>}
        {msgs.map((msg, i) => (
          <div key={i} className={`msg msg-${msg.role}`}>
            {msg.role === 'assistant' ? (
              streamingEmpty && i === lastIdx ? (
                <span className="typing-dots">
                  <span />
                  <span />
                  <span />
                </span>
              ) : (
                <div className="md">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
                  {loading && i === lastIdx && <span className="stream-cursor">▍</span>}
                </div>
              )
            ) : (
              <div className="msg-text">
                {msg.content}
                {msg.images?.length ? <span className="msg-img-tag">🖼 含页面截图</span> : null}
              </div>
            )}
            {msg.role === 'assistant' && msg.content && !(loading && i === lastIdx) && (
              <button className="icon-btn msg-copy" title="复制" onClick={() => copyMsg(msg.content, i)}>
                {copiedIdx === i ? <Check size={12} /> : <Copy size={12} />}
              </button>
            )}
          </div>
        ))}
        {statusLine && <div className="chat-status">{statusLine}</div>}
      </div>

      <div className="chat-input-container">
        <input
          ref={inputRef}
          type="text"
          className="chat-input"
          placeholder={placeholder}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={loading}
        />
        {loading ? (
          <button className="send-btn stop" title="停止生成" onClick={onStop}>
            <Square size={14} />
          </button>
        ) : (
          <button className="send-btn" title="发送" onClick={submit} disabled={!input.trim()}>
            <Send size={14} />
          </button>
        )}
      </div>
    </div>
  );
});
