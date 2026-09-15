importScripts("lib/zip.js");

const BULK_KEY = "pplxBulkJob";
const BULK_FILES_KEY = "pplxBulkFiles";
const BULK_CANCEL_KEY = "pplxBulkCancel";
const OFFSCREEN_URL = "offscreen.html";
const MAX_ZIP_BYTES = self.PplxExport.MAX_ZIP_DOWNLOAD_BYTES || 20 * 1024 * 1024;
/** Soft limits — flush a ZIP early so large jobs stay under the hard cap. */
const BATCH_MAX_FILES = 30;
const BATCH_SOFT_BYTES = 12 * 1024 * 1024;

/** Single-flight lock — only one bulk job at a time (also mirrored in storage). */
let bulkRunning = false;
let offscreenCreating = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function utf8ByteLength(text) {
  try {
    return new TextEncoder().encode(String(text ?? "")).length;
  } catch {
    return String(text ?? "").length;
  }
}

function sanitizeFilename(name, fallback = "perplexport.md") {
  let base = String(name || fallback).replace(/\\/g, "/");
  const parts = base.split("/").filter(Boolean);
  base = parts[parts.length - 1] || fallback;
  base = base
    .replace(/[\u0000-\u001f<>:"|?*]/g, "_")
    .replace(/^\.+/, "")
    .trim();
  if (!base || base === "." || base === "..") return fallback;
  return base.slice(0, 180);
}

function sanitizeFolder(name) {
  const folder = sanitizeFilename(name, "perplexport").replace(
    /\.zip$/i,
    ""
  );
  return folder || "perplexport";
}

/**
 * Only allow Perplexity /search/ thread URLs.
 */
function normalizeThreadUrl(raw) {
  let u;
  try {
    u = new URL(String(raw || ""), "https://www.perplexity.ai");
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  if (u.hostname !== "www.perplexity.ai" && u.hostname !== "perplexity.ai") {
    return null;
  }
  if (!u.pathname.startsWith("/search/")) return null;
  if (u.pathname.includes("..")) return null;
  return `https://www.perplexity.ai${u.pathname}${u.search}`;
}

function isTrustedExtensionSender(sender) {
  const url = sender?.tab?.url || sender?.url || "";
  try {
    const u = new URL(url);
    return (
      u.protocol === "https:" &&
      (u.hostname === "www.perplexity.ai" || u.hostname === "perplexity.ai")
    );
  } catch {
    return false;
  }
}

function toDataUrl(content, mime) {
  const type = mime || "text/plain;charset=utf-8";
  return `data:${type},${encodeURIComponent(content)}`;
}

/**
 * Mark any leftover "running" job as interrupted when the worker starts.
 * Must finish before accepting new bulk jobs (see bulkReady).
 */
async function reconcileStaleBulkJob() {
  try {
    const data = await chrome.storage.local.get(BULK_KEY);
    const job = data[BULK_KEY];
    if (job?.status !== "running") return;

    const snapshotStartedAt = job.startedAt;
    // Re-read immediately before write to avoid clobbering a job that just started
    const again = await chrome.storage.local.get(BULK_KEY);
    const current = again[BULK_KEY];
    if (
      current?.status !== "running" ||
      current?.startedAt !== snapshotStartedAt
    ) {
      return;
    }

    await writeJob({
      ...current,
      status: "error",
      error: "Bulk export was interrupted (extension worker restarted).",
      finishedAt: new Date().toISOString(),
    });
    await clearCollected();
    await clearCancelFlag();
    if (current.openerTabId) {
      await notifyOpener(current.openerTabId, {
        type: "pplx-bulk-progress",
        status: "error",
        error: "Bulk export was interrupted (extension worker restarted).",
        done: current.done,
        failed: current.failed,
        total: current.total,
      });
    }
  } catch {
    // ignore
  }
}

const bulkReady = reconcileStaleBulkJob();

async function downloadData({ filename, url, content, mime, saveAs }) {
  let downloadUrl = null;
  if (typeof content === "string") {
    downloadUrl = toDataUrl(content, mime);
  } else if (typeof url === "string" && url.startsWith("data:")) {
    downloadUrl = url;
  } else {
    throw new Error("Downloads must use inline data (data: URL or content).");
  }

  await chrome.downloads.download({
    url: downloadUrl,
    filename: sanitizeFilename(filename, "perplexport.md"),
    saveAs: Boolean(saveAs),
  });
}

function uniqueZipName(name, used) {
  let base = sanitizeFilename(name, "export.txt");
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  let i = 2;
  while (used.has(`${stem}-${i}${ext}`)) i += 1;
  const next = `${stem}-${i}${ext}`;
  used.add(next);
  return next;
}

async function hasOffscreenDocument() {
  if (!chrome.runtime.getContexts) return false;
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreenDocument()) return;
  if (offscreenCreating) {
    await offscreenCreating;
    if (await hasOffscreenDocument()) return;
  }

  offscreenCreating = (async () => {
    try {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: ["BLOBS"],
        justification: "Create a Blob URL to download large ZIP exports safely.",
      });
      await sleep(150);
    } catch (err) {
      if (!(await hasOffscreenDocument())) throw err;
    }
  })();

  try {
    await offscreenCreating;
  } finally {
    offscreenCreating = null;
  }
}

async function sendOffscreenDownload(payload, attempts = 4) {
  let lastError = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      await ensureOffscreen();
      const result = await chrome.runtime.sendMessage({
        type: "pplx-offscreen-download",
        ...payload,
      });
      if (result?.ok) return result;
      lastError = new Error(result?.error || "Offscreen ZIP download failed.");
    } catch (err) {
      lastError = err;
    }
    await sleep(200 * (i + 1));
  }
  throw lastError || new Error("Offscreen ZIP download failed.");
}

/**
 * Download ZIP via offscreen Blob URL (single path — no data-URL branch).
 */
async function downloadZip(files, filename, saveAs = true) {
  const bytes = self.PplxExport.createZip(files);
  if (bytes.length > MAX_ZIP_BYTES) {
    const mb = (bytes.length / (1024 * 1024)).toFixed(1);
    throw new Error(
      `ZIP is too large (${mb} MB). Export fewer threads or try Markdown only.`
    );
  }

  await sendOffscreenDownload({
    base64: self.PplxExport.bytesToBase64(bytes),
    filename: sanitizeFilename(filename, "perplexport.zip"),
    mime: "application/zip",
    saveAs: Boolean(saveAs),
  });
}

async function waitForTabComplete(tabId, timeoutMs = 45000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete" && /\/search\//.test(tab.url || "")) {
      return tab;
    }
    await sleep(300);
  }
  throw new Error("The thread did not finish loading in time.");
}

async function sendExport(tabId, payload, attempts = 8) {
  let lastError = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const result = await chrome.tabs.sendMessage(tabId, payload);
      if (result?.ok) return result;
      // Logical failure from the content script — do not retry
      throw new Error(result?.error || "Export failed");
    } catch (err) {
      const msg = err?.message || String(err);
      const transient =
        /Receiving end does not exist|Could not establish connection|message port closed|Extension context invalidated/i.test(
          msg
        );
      if (!transient) throw err;
      lastError = err;
      try {
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
      } catch {
        // ignore inject errors mid-load
      }
    }
    await sleep(700);
  }
  throw lastError || new Error("Could not talk to the thread tab.");
}

async function notifyOpener(openerTabId, message) {
  if (!openerTabId) return;
  try {
    await chrome.tabs.sendMessage(openerTabId, message);
  } catch {
    // opener may be gone
  }
}

async function clearCollected() {
  try {
    await chrome.storage.session.remove(BULK_FILES_KEY);
  } catch {
    // ignore
  }
}

async function clearCancelFlag() {
  try {
    await chrome.storage.session.remove(BULK_CANCEL_KEY);
  } catch {
    // ignore
  }
}

async function isBulkCancelled() {
  try {
    const data = await chrome.storage.session.get(BULK_CANCEL_KEY);
    return Boolean(data[BULK_CANCEL_KEY]);
  } catch {
    return false;
  }
}

async function writeJob(job) {
  await chrome.storage.local.set({ [BULK_KEY]: job });
}

async function failJob(job, err, openerTabId) {
  const error = err?.message || String(err);
  const finished = {
    ...job,
    status: "error",
    error,
    finishedAt: new Date().toISOString(),
  };
  await writeJob(finished);
  await clearCollected();
  await clearCancelFlag();
  await notifyOpener(openerTabId, {
    type: "pplx-bulk-progress",
    status: "error",
    error,
    done: job.done,
    failed: job.failed,
    total: job.total,
  });
  return finished;
}

async function runBulkJob(job) {
  const { threads, format, folder, openerTabId } = job;
  const total = threads.length;
  let done = 0;
  let failed = 0;
  const errors = [];
  const usedNames = new Set();
  const zipNames = [];
  let batch = [];
  let batchBytes = 0;
  let partIndex = 0;
  let multiMode = false;
  const baseFolder = folder || "perplexport";
  const state = { ...job, status: "running", done, failed, total, errors };

  const flushBatch = async ({ force = false, moreComing = false } = {}) => {
    if (!batch.length) return;
    if (
      !force &&
      batch.length < BATCH_MAX_FILES &&
      batchBytes < BATCH_SOFT_BYTES
    ) {
      return;
    }

    if (moreComing) multiMode = true;
    partIndex += 1;

    const zipFiles = batch.map((f) => ({
      name: `${baseFolder}/${f.name}`,
      content: f.content,
    }));
    const useParts = multiMode || partIndex > 1 || zipNames.length > 0;
    const zipName = useParts
      ? `${baseFolder}-part-${String(partIndex).padStart(2, "0")}.zip`
      : `${baseFolder}.zip`;

    await notifyOpener(openerTabId, {
      type: "pplx-bulk-progress",
      status: "zipping",
      done,
      failed,
      total,
      collected: batch.length,
      part: useParts ? partIndex : null,
      zipName,
    });

    // First ZIP may prompt Save As; later parts download quietly
    await downloadZip(zipFiles, zipName, partIndex === 1);
    zipNames.push(zipName);
    batch = [];
    batchBytes = 0;
  };

  await writeJob(state);
  await clearCollected();
  await clearCancelFlag();

  try {
    for (let i = 0; i < threads.length; i += 1) {
      if (await isBulkCancelled()) {
        // Best-effort: save whatever we already collected
        try {
          await flushBatch({ force: true });
        } catch {
          // ignore zip errors on cancel
        }
        const cancelled = {
          ...state,
          status: "cancelled",
          done,
          failed,
          total,
          errors,
          collected: done,
          zipNames,
          zipName: zipNames[zipNames.length - 1] || null,
          error: "Cancelled by user.",
          finishedAt: new Date().toISOString(),
        };
        await writeJob(cancelled);
        await clearCollected();
        await clearCancelFlag();
        await notifyOpener(openerTabId, {
          type: "pplx-bulk-progress",
          status: "cancelled",
          done,
          failed,
          total,
          errors,
          collected: done,
          zipNames,
          zipName: zipNames[zipNames.length - 1] || null,
          error: "Cancelled by user.",
        });
        return cancelled;
      }

      const thread = threads[i];
      await notifyOpener(openerTabId, {
        type: "pplx-bulk-progress",
        index: i,
        total,
        done,
        failed,
        current: thread.title || thread.url,
        status: "loading",
      });

      let tabId = null;
      try {
        const safeUrl = normalizeThreadUrl(thread.url);
        if (!safeUrl) {
          throw new Error("Invalid or non-Perplexity thread URL.");
        }

        const tab = await chrome.tabs.create({
          url: safeUrl,
          active: false,
        });
        tabId = tab.id;
        await waitForTabComplete(tabId);
        await sleep(800);

        const exported = await sendExport(tabId, {
          type: "pplx-export",
          action: format === "json" ? "json" : "md",
          quiet: true,
          collect: true,
        });

        if (!exported?.content) {
          throw new Error("Empty export result");
        }

        const contentBytes = utf8ByteLength(exported.content);
        if (contentBytes > MAX_ZIP_BYTES) {
          throw new Error(
            `Thread export is too large (${(contentBytes / (1024 * 1024)).toFixed(1)} MB) for a ZIP part.`
          );
        }

        // Flush before adding if this file would push the soft limit / file cap
        if (
          batch.length &&
          (batch.length >= BATCH_MAX_FILES ||
            batchBytes + contentBytes >= BATCH_SOFT_BYTES)
        ) {
          try {
            await flushBatch({ force: true, moreComing: true });
          } catch (zipErr) {
            batch = [];
            batchBytes = 0;
            const fatal = new Error(
              zipErr?.message || "Failed to write ZIP batch."
            );
            fatal.pplxZipFlush = true;
            throw fatal;
          }
        }

        const name = uniqueZipName(
          exported.filename ||
            `thread-${i + 1}.${format === "json" ? "json" : "md"}`,
          usedNames
        );
        batch.push({ name, content: exported.content });
        batchBytes += contentBytes;

        try {
          await flushBatch({
            moreComing: i < threads.length - 1,
          });
        } catch (zipErr) {
          batch = [];
          batchBytes = 0;
          const fatal = new Error(
            zipErr?.message || "Failed to write ZIP batch."
          );
          fatal.pplxZipFlush = true;
          throw fatal;
        }
        done += 1;
      } catch (err) {
        if (err?.pplxZipFlush) throw err;
        failed += 1;
        errors.push({
          url: thread.url,
          title: thread.title,
          error: err?.message || String(err),
        });
      } finally {
        if (tabId != null) {
          try {
            await chrome.tabs.remove(tabId);
          } catch {
            // ignore
          }
        }
      }

      Object.assign(state, {
        status: "running",
        done,
        failed,
        total,
        errors,
        collected: done,
        zipNames,
      });
      await writeJob(state);
      await notifyOpener(openerTabId, {
        type: "pplx-bulk-progress",
        index: i,
        total,
        done,
        failed,
        current: thread.title || thread.url,
        status: "tick",
        collected: done,
        zipNames,
      });
      await sleep(600);
    }

    await flushBatch({ force: true, moreComing: false });

    await clearCollected();
    await clearCancelFlag();

    const finished = {
      ...job,
      status: "done",
      done,
      failed,
      total,
      errors,
      zipName: zipNames[0] || null,
      zipNames,
      collected: done,
      finishedAt: new Date().toISOString(),
    };
    await writeJob(finished);
    await notifyOpener(openerTabId, {
      type: "pplx-bulk-progress",
      status: "done",
      done,
      failed,
      total,
      errors,
      zipName: zipNames[0] || null,
      zipNames,
      collected: done,
    });
    return finished;
  } catch (err) {
    return failJob(
      {
        ...state,
        done,
        failed,
        total,
        errors,
        collected: done,
        zipNames,
      },
      err,
      openerTabId
    );
  } finally {
    bulkRunning = false;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "pplx-inject-harvester") {
    (async () => {
      try {
        const tabId = sender.tab?.id;
        if (tabId == null) throw new Error("Missing tab for harvester inject.");
        await chrome.scripting.executeScript({
          target: { tabId },
          world: "MAIN",
          files: ["lib/page-harvest.js"],
        });
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || String(err) });
      }
    })();
    return true;
  }

  if (message?.type === "pplx-download") {
    (async () => {
      try {
        await downloadData(message);
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || String(err) });
      }
    })();
    return true;
  }

  if (message?.type === "pplx-bulk-cancel") {
    (async () => {
      try {
        await bulkReady;
        await chrome.storage.session.set({ [BULK_CANCEL_KEY]: true });
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || String(err) });
      }
    })();
    return true;
  }

  if (message?.type === "pplx-bulk-status") {
    (async () => {
      try {
        await bulkReady;
        const data = await chrome.storage.local.get(BULK_KEY);
        sendResponse({
          ok: true,
          job: data[BULK_KEY] || null,
          running: bulkRunning,
        });
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || String(err) });
      }
    })();
    return true;
  }

  if (message?.type === "pplx-bulk-start") {
    (async () => {
      try {
        await bulkReady;
        if (!isTrustedExtensionSender(sender)) {
          throw new Error("Bulk export must be started from a Perplexity tab.");
        }
        if (bulkRunning) {
          throw new Error("A bulk export is already running.");
        }

        const stored = await chrome.storage.local.get(BULK_KEY);
        if (stored[BULK_KEY]?.status === "running") {
          throw new Error("A bulk export is already running.");
        }

        const openerTabId = sender.tab?.id || null;
        const folder = sanitizeFolder(message.folder || "perplexport");
        const threads = (message.threads || [])
          .map((t) => ({
            title: String(t?.title || "").slice(0, 300),
            url: normalizeThreadUrl(t?.url),
            date: t?.date || null,
          }))
          .filter((t) => t.url);

        if (!threads.length) {
          throw new Error("No valid Perplexity thread URLs to export.");
        }

        const job = {
          threads,
          format: message.format === "json" ? "json" : "md",
          folder,
          openerTabId,
          startedAt: new Date().toISOString(),
        };

        bulkRunning = true;
        sendResponse({ ok: true, started: true, total: job.threads.length });
        runBulkJob(job).catch(async (err) => {
          bulkRunning = false;
          await failJob(job, err, openerTabId);
        });
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || String(err) });
      }
    })();
    return true;
  }

  return false;
});
