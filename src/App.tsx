import React, { useState, KeyboardEvent } from 'react';
import './index.css';
import { DocumentViewer } from './components/DocumentViewer';
import { AIAgent } from './lib/agent';
import type { ChatMsg } from './lib/agent';
import { extractTextFromPDF } from './lib/pdf';
import { open } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';

function App() {
  const [filePath, setFilePath] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState<string>('');
  const [docText, setDocText] = useState<string>('');
  const [selectedText, setSelectedText] = useState<string>('');
  
  const [chat1Msgs, setChat1Msgs] = useState<ChatMsg[]>([]);
  const [chat1Input, setChat1Input] = useState('');
  const [isChat1Loading, setIsChat1Loading] = useState(false);

  const [chat2Msgs, setChat2Msgs] = useState<ChatMsg[]>([]);
  const [chat2Input, setChat2Input] = useState('');
  const [isChat2Loading, setIsChat2Loading] = useState(false);

  const handleOpenFile = async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: 'Documents', extensions: ['pdf', 'docx', 'pptx', 'doc', 'ppt'] }]
      });

      if (selected && typeof selected === 'string') {
        // Rust backend command to handle conversion for Office files
        const processedPath = await invoke<string>('convert_to_pdf_if_needed', { filePath: selected });
        
        setFilePath(processedPath);
        setDocText('');
        
        // Read the file as a byte array
        const bufferArray = await invoke<number[]>('read_file_buffer', { filePath: processedPath });
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

  const getAgent = () => {
    if (!apiKey) {
      alert("Please enter an OpenAI API Key first.");
      return null;
    }
    return new AIAgent({ apiKey, model: 'gpt-4o-mini' });
  };

  const handleChat1Submit = async (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && chat1Input.trim()) {
      const agent = getAgent();
      if (!agent) return;

      const newMsgs: ChatMsg[] = [...chat1Msgs, { role: 'user', content: chat1Input }];
      setChat1Msgs(newMsgs);
      setChat1Input('');
      setIsChat1Loading(true);

      try {
        const reply = await agent.askGlobalContext(newMsgs, docText);
        setChat1Msgs([...newMsgs, { role: 'assistant', content: reply }]);
      } catch (err: any) {
        setChat1Msgs([...newMsgs, { role: 'system', content: `Error: ${err.message}` }]);
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

      const newMsgs: ChatMsg[] = [...chat2Msgs, { role: 'user', content: prompt }];
      setChat2Msgs(newMsgs);
      setChat2Input('');
      setIsChat2Loading(true);

      try {
        const reply = await agent.askDetail(chat1Msgs, newMsgs, docText, selectedText);
        setChat2Msgs([...newMsgs, { role: 'assistant', content: reply }]);
      } catch (err: any) {
        setChat2Msgs([...newMsgs, { role: 'system', content: `Error: ${err.message}` }]);
      } finally {
        setIsChat2Loading(false);
      }
    }
  };

  return (
    <div className="app-container">
      {/* Document Pane (Left - 50%) */}
      <div className="document-pane">
        <div className="pane-header">Document Viewer</div>
        <div className="toolbar" style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
          <div style={{ display: 'flex', gap: '10px' }}>
            <button onClick={handleOpenFile}>Open PDF/Word/PPT</button>
            <input 
              type="password" 
              placeholder="OpenAI API Key" 
              value={apiKey} 
              onChange={e => setApiKey(e.target.value)}
              style={{ padding: '5px', borderRadius: '3px', border: '1px solid #555', background: '#222', color: 'white' }}
            />
          </div>
          {selectedText && (
            <div style={{ fontSize: '0.8rem', background: '#3c3c3c', padding: '5px', borderRadius: '4px' }}>
              <strong>Selected:</strong> {selectedText.length > 50 ? selectedText.substring(0, 50) + '...' : selectedText}
            </div>
          )}
        </div>
        <div className="pane-content" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: filePath ? 'flex-start' : 'center' }}>
          {filePath ? (
            <DocumentViewer filePath={filePath} onTextSelected={setSelectedText} />
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
             <div key={i} style={{ 
               alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start',
               background: msg.role === 'user' ? '#0e639c' : '#333',
               padding: '8px', borderRadius: '6px', maxWidth: '90%', fontSize: '0.9rem'
             }}>
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
            onChange={e => setChat1Input(e.target.value)}
            onKeyDown={handleChat1Submit}
            disabled={isChat1Loading}
          />
        </div>
      </div>

      {/* Chat 2 Pane (Right - 25%) */}
      <div className="chat-pane">
        <div className="pane-header">Chat 2 (Detail & Details)</div>
        <div className="pane-content" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <p style={{ fontSize: '0.8rem', color: '#888' }}>Ask detailed questions. Uses Chat 1 context and current text selection.</p>
          {chat2Msgs.map((msg, i) => (
             <div key={i} style={{ 
               alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start',
               background: msg.role === 'user' ? '#0e639c' : '#333',
               padding: '8px', borderRadius: '6px', maxWidth: '90%', fontSize: '0.9rem'
             }}>
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
            onChange={e => setChat2Input(e.target.value)}
            onKeyDown={handleChat2Submit}
            disabled={isChat2Loading}
          />
        </div>
      </div>
    </div>
  );
}

export default App;
