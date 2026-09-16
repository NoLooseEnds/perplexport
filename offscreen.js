/**
 * Offscreen documents only get chrome.runtime — not chrome.downloads.
 * Create/revoke blob: URLs here; the service worker performs the download.
 */
const liveUrls = new Set();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only this extension — never tab content scripts
  if (sender.tab) return false;
  if (sender.id != null && sender.id !== chrome.runtime.id) return false;

  if (message?.type === "pplx-offscreen-create-url") {
    try {
      const binary = atob(message.base64 || "");
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
      }
      const blob = new Blob([bytes], {
        type: message.mime || "application/zip",
      });
      const url = URL.createObjectURL(blob);
      liveUrls.add(url);
      sendResponse({ ok: true, url });
    } catch (err) {
      sendResponse({ ok: false, error: err?.message || String(err) });
    }
    return false;
  }

  if (message?.type === "pplx-offscreen-revoke-url") {
    try {
      const url = message.url;
      if (url && liveUrls.has(url)) {
        URL.revokeObjectURL(url);
        liveUrls.delete(url);
      }
      sendResponse({ ok: true });
    } catch (err) {
      sendResponse({ ok: false, error: err?.message || String(err) });
    }
    return false;
  }

  return false;
});
