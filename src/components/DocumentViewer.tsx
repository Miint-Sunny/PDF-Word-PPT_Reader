import { useEffect, useRef, useState, forwardRef, useImperativeHandle } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { invoke } from '@tauri-apps/api/core';
import type { ImagePart } from '../lib/agent';
import 'pdfjs-dist/web/pdf_viewer.css';

// Tell PDF.js where to find the worker
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.mjs',
  import.meta.url
).toString();

interface DocumentViewerProps {
  filePath: string;
  onTextSelected?: (text: string) => void;
}

// Imperative handle so the parent can grab a page image for vision models.
export interface DocumentViewerHandle {
  // Capture the page most visible in the viewport as a base64 PNG (downscaled).
  captureVisiblePage: () => ImagePart | null;
}

// Downscale a source canvas to a max dimension and return base64 (no data: prefix).
function canvasToImagePart(source: HTMLCanvasElement, maxDim = 1024): ImagePart | null {
  const w = source.width;
  const h = source.height;
  if (!w || !h) return null;
  const scale = Math.min(1, maxDim / Math.max(w, h));
  const target = document.createElement('canvas');
  target.width = Math.round(w * scale);
  target.height = Math.round(h * scale);
  const ctx = target.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(source, 0, 0, target.width, target.height);
  const dataUrl = target.toDataURL('image/png');
  const base64 = dataUrl.split(',')[1];
  if (!base64) return null;
  return { mimeType: 'image/png', data: base64 };
}

export const DocumentViewer = forwardRef<DocumentViewerHandle, DocumentViewerProps>(
  ({ filePath, onTextSelected }, ref) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const canvasesRef = useRef<HTMLCanvasElement[]>([]);
    const [numPages, setNumPages] = useState<number>(0);
    const [error, setError] = useState<string>('');

    useImperativeHandle(ref, () => ({
      captureVisiblePage: () => {
        const canvases = canvasesRef.current;
        if (!canvases.length) return null;
        // Pick the canvas with the greatest vertical overlap with the viewport.
        const vh = window.innerHeight || document.documentElement.clientHeight;
        let best: HTMLCanvasElement | null = null;
        let bestVisible = -1;
        for (const c of canvases) {
          const r = c.getBoundingClientRect();
          const visible = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
          if (visible > bestVisible) {
            bestVisible = visible;
            best = c;
          }
        }
        const chosen = best ?? canvases[0];
        return chosen ? canvasToImagePart(chosen) : null;
      },
    }));

    useEffect(() => {
      let active = true;

      const loadPdf = async () => {
        try {
          // Fetch file buffer from Rust backend
          const bufferArray = await invoke<number[]>('read_file_buffer', { filePath });
          const buffer = new Uint8Array(bufferArray);

          if (!buffer || !active) return;

          const loadingTask = pdfjsLib.getDocument({ data: buffer });
          const pdf = await loadingTask.promise;

          if (!active) return;
          setNumPages(pdf.numPages);
          setError('');

          const container = containerRef.current;
          if (!container) return;

          // Clear previous canvases
          container.innerHTML = '';
          canvasesRef.current = [];

          // Render all pages (for MVP. In production, use virtual scrolling)
          for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
            const page = await pdf.getPage(pageNum);
            const viewport = page.getViewport({ scale: 1.5 }); // Adjust scale as needed

            const pageContainer = document.createElement('div');
            pageContainer.style.position = 'relative';
            pageContainer.style.marginBottom = '20px';
            pageContainer.style.boxShadow = '0 4px 6px rgba(0,0,0,0.3)';
            pageContainer.style.backgroundColor = 'white';
            pageContainer.style.width = `${viewport.width}px`;
            pageContainer.style.height = `${viewport.height}px`;

            const canvas = document.createElement('canvas');
            const context = canvas.getContext('2d');
            if (!context) continue;

            canvas.height = viewport.height;
            canvas.width = viewport.width;
            canvas.style.display = 'block';

            pageContainer.appendChild(canvas);

            // Text Layer for selection
            const textLayerDiv = document.createElement('div');
            textLayerDiv.className = 'textLayer';
            textLayerDiv.style.width = `${viewport.width}px`;
            textLayerDiv.style.height = `${viewport.height}px`;
            textLayerDiv.style.setProperty('--scale-factor', '1.5');
            pageContainer.appendChild(textLayerDiv);

            container.appendChild(pageContainer);
            canvasesRef.current.push(canvas);

            const renderContext = {
              canvasContext: context,
              viewport: viewport,
              canvas: canvas,
            };

            await page.render(renderContext).promise;

            // Render Text
            const textContent = await page.getTextContent();
            // @ts-ignore
            const textLayer = new pdfjsLib.TextLayer({
              textContentSource: textContent,
              container: textLayerDiv,
              viewport: viewport,
            });
            await textLayer.render();
          }
        } catch (err: any) {
          if (active) setError(err.message || 'Failed to load PDF');
        }
      };

      if (filePath) {
        loadPdf();
      }

      return () => {
        active = false;
      };
    }, [filePath]);

    const handleMouseUp = () => {
      const text = window.getSelection()?.toString();
      if (text && text.trim().length > 0 && onTextSelected) {
        onTextSelected(text.trim());
      }
    };

    if (error) {
      return <div style={{ color: 'red', padding: 20 }}>Error: {error}</div>;
    }

    return (
      <div
        onMouseUp={handleMouseUp}
        style={{ padding: '20px', width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center' }}
      >
        <p style={{ marginBottom: 10, color: '#aaa' }}>Pages: {numPages}</p>
        <div
          ref={containerRef}
          style={{ width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center' }}
        />
      </div>
    );
  }
);
