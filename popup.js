const statusEl = document.getElementById("status");
const buttons = Array.from(document.querySelectorAll("button[data-action]"));

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function isPerplexity(url = "") {
  try {
    const u = new URL(url);
    return (
      (u.hostname === "www.perplexity.ai" || u.hostname === "perplexity.ai") &&
      u.protocol.startsWith("http")
    );
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientMessagingError(err) {
  const msg = err?.message || String(err);
  return /Receiving end does not exist|Could not establish connection|message port closed|Extension context invalidated/i.test(
    msg
  );
}

async function injectScripts(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: [
      "lib/extract.js",
      "lib/format.js",
      "lib/project.js",
      "lib/zip.js",
      "content.js",
    ],
  });
  await chrome.scripting.insertCSS({
    target: { tabId },
    files: ["content.css"],
  });
}

async function sendExportWithRetry(tabId, action, attempts = 8) {
  let lastError = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, {
        type: "pplx-export",
        action,
      });
      if (response?.ok) return response;
      throw new Error(response?.error || "Export failed");
    } catch (err) {
      if (!isTransientMessagingError(err)) throw err;
      lastError = err;
      try {
        await injectScripts(tabId);
      } catch {
        // ignore inject mid-load
      }
    }
    await sleep(700);
  }
  throw lastError || new Error("Could not export");
}

async function refreshState() {
  const tab = await getActiveTab();
  if (!tab || !isPerplexity(tab.url)) {
    statusEl.textContent = "Open a perplexity.ai tab";
    buttons.forEach((b) => (b.disabled = true));
    return;
  }

  statusEl.textContent = "Ready — will scroll the thread on export";
  buttons.forEach((b) => (b.disabled = false));
}

async function exportAction(action) {
  const tab = await getActiveTab();
  if (!tab?.id) return;

  statusEl.textContent = "Loading thread and exporting…";
  buttons.forEach((b) => (b.disabled = true));

  try {
    await sendExportWithRetry(tab.id, action);
    statusEl.textContent =
      action === "copy"
        ? "Markdown copied"
        : action === "json"
          ? "JSON downloaded"
          : "Markdown downloaded";
  } catch (err) {
    statusEl.textContent = err.message || "Could not export";
  } finally {
    refreshState();
  }
}

buttons.forEach((btn) => {
  btn.addEventListener("click", () => exportAction(btn.dataset.action));
});

refreshState();
