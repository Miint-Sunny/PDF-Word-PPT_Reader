import {
  useEffect,
  useRef,
  useState,
  forwardRef,
  useImperativeHandle,
  useCallback,
  KeyboardEvent,
} from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import { invoke } from '@tauri-apps/api/core';
import { ZoomIn, ZoomOut, ArrowLeftRight, Search, ChevronUp, ChevronDown, X } from 'lucide-react';
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
  captureVisiblePage: () => ImagePart | null;
}

const PAGE_GAP = 20; // px between pages
const PAD = 20; // container padding
const OVERSCAN = 2; // pages rendered beyond the visible range
const KEEP = 4; // pages kept beyond the visible range before teardown

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
  const base64 = target.toDataURL('image/png').split(',')[1];
  return base64 ? { mimeType: 'image/png', data: base64 } : null;
}

// Wrap query matches inside a rendered text layer with <mark> (span-local only:
// matches spanning pdf.js span boundaries are not highlighted — acceptable MVP).
function highlightInTextLayer(layer: HTMLElement, query: string) {
  // Undo previous marks.
  layer.querySelectorAll('mark.search-hit').forEach((m) => {
    m.replaceWith(document.createTextNode(m.textContent ?? ''));
  });
  layer.normalize?.();
  if (!query) return;

  const q = query.toLowerCase();
  layer.querySelectorAll('span').forEach((span) => {
    if (span.children.length) return;
    const text = span.textContent ?? '';
    const lower = text.toLowerCase();
    let i = lower.indexOf(q);
    if (i === -1) return;
    const frag = document.createDocumentFragment();
    let pos = 0;
    while (i !== -1) {
      frag.appendChild(document.createTextNode(text.slice(pos, i)));
      const mark = document.createElement('mark');
      mark.className = 'search-hit';
      mark.textContent = text.slice(i, i + query.length);
      frag.appendChild(mark);
      pos = i + query.length;
      i = lower.indexOf(q, pos);
    }
    frag.appendChild(document.createTextNode(text.slice(pos)));
    span.textContent = '';
    span.appendChild(frag);
  });
}

interface RenderedPage {
  canvas: HTMLCanvasElement;
  textLayerDiv: HTMLDivElement;
  renderTask?: RenderTask;
}

export const DocumentViewer = forwardRef<DocumentViewerHandle, DocumentViewerProps>(
  ({ filePath, onTextSelected }, ref) => {
    const scrollRef = useRef<HTMLDivElement>(null);
    const wrapperRefs = useRef<Map<number, HTMLDivElement>>(new Map());
    const renderedRef = useRef<Map<number, RenderedPage>>(new Map());
    const renderingRef = useRef<Set<number>>(new Set());
    const pdfRef = useRef<PDFDocumentProxy | null>(null);
    const dimsRef = useRef<{ w: number; h: number }[]>([]); // per page @ scale 1
    const offsetsRef = useRef<number[]>([]); // wrapper top offsets @ current scale
    const pageTextsRef = useRef<string[] | null>(null); // lazy search index
    const queryRef = useRef<string>(''); // active (executed) search query

    const [numPages, setNumPages] = useState(0);
    const [currentPage, setCurrentPage] = useState(1);
    const [pageInput, setPageInput] = useState('1');
    const [scale, setScale] = useState(1.2);
    const [layoutTick, setLayoutTick] = useState(0); // bumps when dims are ready
    const [error, setError] = useState('');

    // Search UI state
    const [searchInput, setSearchInput] = useState('');
    const [searchStatus, setSearchStatus] = useState('');
    const matchesRef = useRef<number[]>([]); // flattened: page number per occurrence
    const [matchIdx, setMatchIdx] = useState(0);
    const [matchTotal, setMatchTotal] = useState(-1); // -1 = no search executed

    // ---- layout helpers --------------------------------------------------
    const recomputeOffsets = useCallback(
      (atScale: number) => {
        const dims = dimsRef.current;
        const offs: number[] = new Array(dims.length);
        let y = PAD;
        for (let i = 0; i < dims.length; i++) {
          offs[i] = y;
          y += dims[i].h * atScale + PAGE_GAP;
        }
        offsetsRef.current = offs;
      },
      []
    );

    const pageAt = (y: number): number => {
      const offs = offsetsRef.current;
      let lo = 0;
      let hi = offs.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (offs[mid] <= y) lo = mid;
        else hi = mid - 1;
      }
      return lo + 1; // 1-based
    };

    // ---- page render/teardown -------------------------------------------
    const unrenderPage = useCallback((pageNum: number) => {
      const entry = renderedRef.current.get(pageNum);
      if (!entry) return;
      entry.renderTask?.cancel();
      entry.canvas.remove();
      entry.textLayerDiv.remove();
      renderedRef.current.delete(pageNum);
    }, []);

    const renderPage = useCallback(
      async (pageNum: number, atScale: number) => {
        const pdf = pdfRef.current;
        const wrapper = wrapperRefs.current.get(pageNum);
        if (!pdf || !wrapper) return;
        if (renderedRef.current.has(pageNum) || renderingRef.current.has(pageNum)) return;
        renderingRef.current.add(pageNum);
        try {
          const page = await pdf.getPage(pageNum);
          // Bail if the doc/scale changed while we awaited.
          if (pdfRef.current !== pdf || !wrapperRefs.current.has(pageNum)) return;

          const viewport = page.getViewport({ scale: atScale });
          const canvas = document.createElement('canvas');
          const context = canvas.getContext('2d');
          if (!context) return;
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          canvas.style.display = 'block';

          const textLayerDiv = document.createElement('div');
          textLayerDiv.className = 'textLayer';
          textLayerDiv.style.width = `${viewport.width}px`;
          textLayerDiv.style.height = `${viewport.height}px`;
          textLayerDiv.style.setProperty('--scale-factor', String(atScale));

          wrapper.appendChild(canvas);
          wrapper.appendChild(textLayerDiv);

          const entry: RenderedPage = { canvas, textLayerDiv };
          renderedRef.current.set(pageNum, entry);

          const renderTask = page.render({ canvasContext: context, viewport, canvas });
          entry.renderTask = renderTask;
          await renderTask.promise.catch(() => {}); // cancelled is fine

          const textContent = await page.getTextContent();
          if (!renderedRef.current.has(pageNum)) return;
          // @ts-ignore TextLayer is exported at runtime
          const textLayer = new pdfjsLib.TextLayer({
            textContentSource: textContent,
            container: textLayerDiv,
            viewport,
          });
          await textLayer.render();
          if (queryRef.current) highlightInTextLayer(textLayerDiv, queryRef.current);
        } catch {
          /* page render failed — leave placeholder empty */
        } finally {
          renderingRef.current.delete(pageNum);
        }
      },
      []
    );

    // Ensure the pages around the viewport are rendered; tear down far ones.
    const ensureWindow = useCallback(() => {
      const el = scrollRef.current;
      const pdf = pdfRef.current;
      if (!el || !pdf) return;
      const top = el.scrollTop;
      const bottom = top + el.clientHeight;
      const first = pageAt(top);
      const last = pageAt(bottom);

      for (let p = Math.max(1, first - OVERSCAN); p <= Math.min(pdf.numPages, last + OVERSCAN); p++) {
        void renderPage(p, scale);
      }
      for (const p of Array.from(renderedRef.current.keys())) {
        if (p < first - KEEP || p > last + KEEP) unrenderPage(p);
      }

      const center = pageAt(top + el.clientHeight / 2);
      setCurrentPage(center);
      setPageInput(String(center));
    }, [renderPage, unrenderPage, scale]);

    const scrollToPage = useCallback((pageNum: number) => {
      const el = scrollRef.current;
      const offs = offsetsRef.current;
      if (!el || !offs.length) return;
      const p = Math.min(Math.max(1, pageNum), offs.length);
      el.scrollTop = offs[p - 1] - PAD / 2;
    }, []);

    // ---- document load ----------------------------------------------------
    useEffect(() => {
      let active = true;
      let loadedPdf: PDFDocumentProxy | null = null;

      const load = async () => {
        try {
          setError('');
          setNumPages(0);
          setMatchTotal(-1);
          setSearchInput('');
          queryRef.current = '';
          matchesRef.current = [];
          pageTextsRef.current = null;

          const buffer = await invoke<ArrayBuffer>('read_file_buffer', { filePath });
          if (!active) return;
          const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise;
          if (!active) {
            void pdf.destroy();
            return;
          }
          loadedPdf = pdf;
          pdfRef.current = pdf;

          // Collect per-page dimensions at scale 1 for the virtual layout.
          const dims: { w: number; h: number }[] = [];
          for (let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i);
            const vp = page.getViewport({ scale: 1 });
            dims.push({ w: vp.width, h: vp.height });
            if (!active) return;
          }
          dimsRef.current = dims;
          recomputeOffsets(1.2);
          setScale(1.2);
          setNumPages(pdf.numPages);
          setCurrentPage(1);
          setPageInput('1');
          setLayoutTick((t) => t + 1);
        } catch (err: any) {
          if (active) setError(err.message || 'Failed to load PDF');
        }
      };

      void load();
      return () => {
        active = false;
        for (const p of Array.from(renderedRef.current.keys())) unrenderPage(p);
        wrapperRefs.current.clear();
        pdfRef.current = null;
        if (loadedPdf) void loadedPdf.destroy();
      };
    }, [filePath, recomputeOffsets, unrenderPage]);

    // After layout is ready or scale changes: recompute offsets & fill viewport.
    useEffect(() => {
      if (!numPages) return;
      recomputeOffsets(scale);
      ensureWindow();
    }, [numPages, scale, layoutTick, recomputeOffsets, ensureWindow]);

    // ---- zoom --------------------------------------------------------------
    const applyScale = (next: number) => {
      const el = scrollRef.current;
      const clamped = Math.min(4, Math.max(0.4, Math.round(next * 100) / 100));
      if (clamped === scale) return;
      // Keep the current page anchored across the zoom change.
      const anchor = el ? pageAt(el.scrollTop + el.clientHeight / 2) : 1;
      for (const p of Array.from(renderedRef.current.keys())) unrenderPage(p);
      setScale(clamped);
      recomputeOffsets(clamped);
      requestAnimationFrame(() => scrollToPage(anchor));
    };

    const fitWidth = () => {
      const el = scrollRef.current;
      const dims = dimsRef.current;
      if (!el || !dims.length) return;
      applyScale((el.clientWidth - PAD * 2) / dims[0].w);
    };

    // ---- search -------------------------------------------------------------
    const buildSearchIndex = async (): Promise<string[]> => {
      if (pageTextsRef.current) return pageTextsRef.current;
      const pdf = pdfRef.current;
      if (!pdf) return [];
      setSearchStatus('正在建立索引…');
      const texts: string[] = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const tc = await page.getTextContent();
        texts.push(tc.items.map((it: any) => it.str ?? '').join(' '));
      }
      pageTextsRef.current = texts;
      setSearchStatus('');
      return texts;
    };

    const applyHighlightsToRendered = (q: string) => {
      for (const { textLayerDiv } of renderedRef.current.values()) {
        highlightInTextLayer(textLayerDiv, q);
      }
    };

    const runSearch = async () => {
      const q = searchInput.trim();
      if (!q) return;
      const texts = await buildSearchIndex();
      const flat: number[] = [];
      const ql = q.toLowerCase();
      texts.forEach((t, i) => {
        const lower = t.toLowerCase();
        let idx = lower.indexOf(ql);
        while (idx !== -1) {
          flat.push(i + 1);
          idx = lower.indexOf(ql, idx + ql.length);
        }
      });
      queryRef.current = q;
      matchesRef.current = flat;
      setMatchTotal(flat.length);
      setMatchIdx(0);
      applyHighlightsToRendered(q);
      if (flat.length) scrollToPage(flat[0]);
    };

    const stepMatch = (dir: 1 | -1) => {
      const flat = matchesRef.current;
      if (!flat.length) return;
      const next = (matchIdx + dir + flat.length) % flat.length;
      setMatchIdx(next);
      scrollToPage(flat[next]);
    };

    const clearSearch = () => {
      setSearchInput('');
      setMatchTotal(-1);
      setMatchIdx(0);
      matchesRef.current = [];
      queryRef.current = '';
      applyHighlightsToRendered('');
    };

    const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        if (searchInput.trim() && searchInput.trim() === queryRef.current) stepMatch(1);
        else void runSearch();
      }
      if (e.key === 'Escape') clearSearch();
    };

    // ---- misc ----------------------------------------------------------------
    useImperativeHandle(ref, () => ({
      captureVisiblePage: () => {
        const entry =
          renderedRef.current.get(currentPage) ?? renderedRef.current.values().next().value;
        return entry ? canvasToImagePart(entry.canvas) : null;
      },
    }));

    const handleMouseUp = () => {
      const text = window.getSelection()?.toString();
      if (text && text.trim().length > 0 && onTextSelected) {
        onTextSelected(text.trim());
      }
    };

    const jumpToInput = () => {
      const n = parseInt(pageInput, 10);
      if (!Number.isNaN(n)) scrollToPage(n);
    };

    if (error) {
      return <div style={{ color: 'red', padding: 20 }}>Error: {error}</div>;
    }

    return (
      <div className="viewer">
        <div className="viewer-toolbar">
          <span className="viewer-group">
            <button className="icon-btn" title="缩小" onClick={() => applyScale(scale - 0.15)}>
              <ZoomOut size={15} />
            </button>
            <span className="viewer-zoom">{Math.round(scale * 100)}%</span>
            <button className="icon-btn" title="放大" onClick={() => applyScale(scale + 0.15)}>
              <ZoomIn size={15} />
            </button>
            <button className="icon-btn" title="适配宽度" onClick={fitWidth}>
              <ArrowLeftRight size={15} />
            </button>
          </span>

          <span className="viewer-group">
            <input
              className="viewer-page-input"
              value={pageInput}
              onChange={(e) => setPageInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && jumpToInput()}
              onBlur={jumpToInput}
              aria-label="页码"
            />
            <span className="viewer-pagecount">/ {numPages}</span>
          </span>

          <span className="viewer-group viewer-search">
            <Search size={14} className="viewer-search-icon" />
            <input
              className="viewer-search-input"
              placeholder="文档内搜索…"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={onSearchKey}
            />
            {matchTotal >= 0 && (
              <span className="viewer-matches">
                {matchTotal === 0 ? '无结果' : `${matchIdx + 1}/${matchTotal}`}
              </span>
            )}
            <button className="icon-btn" title="上一个" onClick={() => stepMatch(-1)} disabled={matchTotal <= 0}>
              <ChevronUp size={14} />
            </button>
            <button className="icon-btn" title="下一个" onClick={() => stepMatch(1)} disabled={matchTotal <= 0}>
              <ChevronDown size={14} />
            </button>
            {(searchInput || matchTotal >= 0) && (
              <button className="icon-btn" title="清除搜索" onClick={clearSearch}>
                <X size={14} />
              </button>
            )}
            {searchStatus && <span className="viewer-matches">{searchStatus}</span>}
          </span>
        </div>

        <div className="viewer-scroll" ref={scrollRef} onScroll={ensureWindow} onMouseUp={handleMouseUp}>
          {Array.from({ length: numPages }, (_, i) => {
            const dim = dimsRef.current[i];
            return (
              <div
                key={`${i + 1}-${scale}`}
                className="viewer-page"
                data-page={i + 1}
                style={{
                  width: dim ? dim.w * scale : 0,
                  height: dim ? dim.h * scale : 0,
                }}
                ref={(el) => {
                  if (el) wrapperRefs.current.set(i + 1, el);
                  else wrapperRefs.current.delete(i + 1);
                }}
              />
            );
          })}
        </div>
      </div>
    );
  }
);
