import { loadPdfBytes } from './pdf_frame.js';
import { requestJson } from '../../shared/api.js';
import { annotationBaseUrl } from './image_history.js';

const ASSETS =
  window.__QUALIFILE__?.offlineAssets === true
    ? '/static/dist/vendor/pdfjs/'
    : '/static/vendor/pdfjs/';
const ASSET_VERSION = encodeURIComponent(window.__QUALIFILE__?.appVersion || '');
let libraryPromise;

function snapshot(document) {
  const normalize = (value) => {
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .filter((key) => !['draggable', 'listening'].includes(key))
          .map((key) => [key, normalize(value[key])])
      );
    }
    return value;
  };
  return JSON.stringify(normalize(document));
}

export class PdfAnnotationSession {
  static async open(path, saved) {
    libraryPromise ||= import(`${ASSETS}pdf.mjs?v=${ASSET_VERSION}`);
    const library = await libraryPromise;
    library.GlobalWorkerOptions.workerSrc = `${ASSETS}pdf.worker.mjs?v=${ASSET_VERSION}`;
    const data = await loadPdfBytes(annotationBaseUrl(path));
    const loading = library.getDocument({
      data,
      isEvalSupported: false,
      useWasm: false,
      cMapUrl: `${ASSETS}cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${ASSETS}standard_fonts/`,
      wasmUrl: `${ASSETS}wasm/`,
    });
    try {
      const pdf = await loading.promise;
      if (pdf.numPages !== saved.document.pages.length) {
        throw new Error('PDF pages changed. Close the editor and reopen the file.');
      }
      return new PdfAnnotationSession(pdf, loading, path, saved);
    } catch (error) {
      await loading.destroy();
      throw error;
    }
  }

  constructor(pdf, loading, path, saved) {
    this.pdf = pdf;
    this.loading = loading;
    this.path = path;
    this.document = structuredClone(saved.document);
    this.savedSnapshot = snapshot(this.document);
    this.hash = saved.hash;
    this.pageIndex = 0;
    this.histories = new Map();
    this.destroyed = false;
  }

  get count() {
    return this.document.pages.length;
  }

  get current() {
    return this.document.pages[this.pageIndex];
  }

  get dirty() {
    return snapshot(this.document) !== this.savedSnapshot;
  }

  update(document) {
    this.document.pages[this.pageIndex] = document;
  }

  async render(index) {
    if (this.destroyed) throw new Error('The PDF editor is closed.');
    const page = await this.pdf.getPage(index + 1);
    const logical = page.getViewport({ scale: 1 });
    const expected = this.document.pages[index];
    if (
      Math.abs(logical.width - expected.width) > 0.01 ||
      Math.abs(logical.height - expected.height) > 0.01
    ) {
      throw new Error('This PDF page has unsupported dimensions.');
    }
    const scale = Math.min(
      2,
      Math.sqrt(8_000_000 / (logical.width * logical.height)),
      8192 / Math.max(logical.width, logical.height)
    );
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(viewport.width));
    canvas.height = Math.max(1, Math.ceil(viewport.height));
    const context = canvas.getContext('2d', { alpha: false });
    this.renderTask = page.render({ canvasContext: context, viewport, background: '#ffffff' });
    try {
      await this.renderTask.promise;
      if (this.destroyed) throw new Error('The PDF editor is closed.');
      this.pageIndex = index;
      return canvas;
    } finally {
      this.renderTask = null;
      page.cleanup();
    }
  }

  async save(mode, filename) {
    const result = await requestJson('/api/pdf-annotations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: this.path,
        mode,
        filename,
        document: this.document,
        expected_hash: this.hash,
      }),
    });
    if (mode === 'overwrite') {
      this.hash = result.hash;
      this.savedSnapshot = snapshot(this.document);
    }
    return result;
  }

  destroy() {
    this.destroyed = true;
    this.renderTask?.cancel();
    void this.loading.destroy();
  }
}
