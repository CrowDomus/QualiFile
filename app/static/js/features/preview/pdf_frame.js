/** Native PDF rendering through a bounded document with an opaque origin. */
export const MAX_PDF_PREVIEW_BYTES = 32 * 1024 * 1024;

export async function loadPdfDataUrl(url, { signal, fetchImpl = fetch } = {}) {
  const source = new URL(url, window.location.href);
  if (source.origin !== window.location.origin) {
    throw new Error('PDF preview source must belong to this application.');
  }
  const response = await fetchImpl(source.href, {
    signal,
    credentials: 'same-origin',
    redirect: 'error',
    cache: 'no-store',
  });
  const mime = (response.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  if (!response.ok || mime !== 'application/pdf' || !response.body) {
    await response.body?.cancel();
    throw new Error('The selected document is not a valid PDF preview.');
  }
  if (Number(response.headers.get('Content-Length')) > MAX_PDF_PREVIEW_BYTES) {
    await response.body.cancel();
    throw new Error(
      'PDF previews are limited to 32 MiB. Use Open to view this document externally.'
    );
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (let reading = true; reading; ) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      reading = !done;
      if (done) break;
      size += value.byteLength;
      if (size > MAX_PDF_PREVIEW_BYTES) {
        throw new Error(
          'PDF previews are limited to 32 MiB. Use Open to view this document externally.'
        );
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  signal?.throwIfAborted();
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (String.fromCharCode(...bytes.subarray(0, 5)) !== '%PDF-') {
    throw new Error('The selected document is not a valid PDF preview.');
  }
  const encodedChunks = [];
  // Multiples of three preserve base64 alignment between bounded chunks.
  for (let index = 0; index < bytes.length; index += 24576) {
    encodedChunks.push(btoa(String.fromCharCode(...bytes.subarray(index, index + 24576))));
  }
  return `data:application/pdf;base64,${encodedChunks.join('')}`;
}

/** Return a disposer owned by the enclosing preview lifecycle. */
export function attachPdfFrame(frame, url) {
  const controller = new AbortController();
  let disposed = false;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 20000);
  frame.referrerPolicy = 'no-referrer';
  void loadPdfDataUrl(url, { signal: controller.signal })
    .then((dataUrl) => {
      if (!controller.signal.aborted && frame.isConnected) {
        // A data document has an opaque origin. A blob URL would inherit app authority.
        frame.src = `${dataUrl}#toolbar=0&navpanes=0`;
      }
    })
    .catch((error) => {
      if (!disposed && frame.isConnected) {
        const notice = document.createElement('div');
        notice.className = 'alert alert-warning';
        notice.role = 'status';
        notice.textContent = timedOut
          ? 'PDF preview timed out. Use Open to view this document externally.'
          : error.message;
        frame.replaceWith(notice);
      }
    })
    .finally(() => clearTimeout(timer));
  return () => {
    disposed = true;
    controller.abort();
    clearTimeout(timer);
    frame.removeAttribute('src');
  };
}
