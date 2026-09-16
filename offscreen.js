chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "pplx-offscreen-download") return;

  // Only accept messages from this extension (not tab content scripts)
  if (sender.tab) {
    sendResponse({ ok: false, error: "Unauthorized" });
    return true;
  }

  (async () => {
    let objectUrl = null;
    let revokeTimer = null;
    let downloadListener = null;
    let settled = false;

    const revoke = () => {
      if (revokeTimer) {
        clearTimeout(revokeTimer);
        revokeTimer = null;
      }
      if (downloadListener) {
        try {
          chrome.downloads.onChanged.removeListener(downloadListener);
        } catch {
          // ignore
        }
        downloadListener = null;
      }
      if (objectUrl) {
        try {
          URL.revokeObjectURL(objectUrl);
        } catch {
          // ignore
        }
        objectUrl = null;
      }
    };

    try {
      const binary = atob(message.base64 || "");
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
      }
      const blob = new Blob([bytes], {
        type: message.mime || "application/zip",
      });
      objectUrl = URL.createObjectURL(blob);

      const filename =
        String(message.filename || "perplexport.zip")
          .replace(/\\/g, "/")
          .split("/")
          .pop()
          .replace(/[\u0000-\u001f<>:"|?*]/g, "_")
          .replace(/^\.+/, "")
          .slice(0, 180) || "perplexport.zip";

      const downloadId = await chrome.downloads.download({
        url: objectUrl,
        filename,
        saveAs: Boolean(message.saveAs),
      });

      const outcome = await new Promise((resolve) => {
        const finish = (result) => {
          if (settled) return;
          settled = true;
          resolve(result);
        };

        downloadListener = (delta) => {
          if (delta.id !== downloadId) return;
          const state = delta.state?.current;
          if (state === "complete") {
            finish({ ok: true, downloadId });
          } else if (state === "interrupted") {
            finish({
              ok: false,
              error: "Download was cancelled or interrupted.",
              downloadId,
            });
          }
        };
        chrome.downloads.onChanged.addListener(downloadListener);

        // Catch races where the download finished before the listener attached
        chrome.downloads
          .search({ id: downloadId })
          .then((items) => {
            const item = items?.[0];
            if (!item) return;
            if (item.state === "complete") {
              finish({ ok: true, downloadId });
            } else if (item.state === "interrupted") {
              finish({
                ok: false,
                error: "Download was cancelled or interrupted.",
                downloadId,
              });
            }
          })
          .catch(() => {});

        revokeTimer = setTimeout(() => {
          finish({
            ok: false,
            error: "Download timed out waiting for completion.",
            downloadId,
          });
        }, 15 * 60 * 1000);
      });

      revoke();
      sendResponse(outcome);
    } catch (err) {
      revoke();
      sendResponse({ ok: false, error: err?.message || String(err) });
    }
  })();

  return true;
});
