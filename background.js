importScripts("lib/zip.js");

const BULK_KEY = "pplxBulkJob";
const BULK_CANCEL_KEY = "pplxBulkCancel";
const BULK_ACTIVE_TAB_KEY = "pplxBulkActiveTab";
const EXPORT_PAYLOAD_PREFIX = "pplxExportPayload_";
const OFFSCREEN_URL = "offscreen.html";
const MAX_ZIP_BYTES = self.PplxExport.MAX_ZIP_DOWNLOAD_BYTES || 14 * 1024 * 1024;
/** Flush a ZIP when uncompressed content nears the hard download/messaging cap. */
const BATCH_SOFT_BYTES = 10 * 1024 * 1024;
/** Avoid giant structured-clone payloads over tabs.sendMessage / session storage. */
const MAX_INLINE_EXPORT_CHARS = 1_500_000;
const MAX_SESSION_EXPORT_BYTES = 8 * 1024 * 1024;

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

/** Folder for Library ZIP grouping when a thread has no Space/project pill. */
const UNCATEGORIZED_FOLDER = "uncategorized";

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

/** Like uniqueZipName but preserves folder prefixes (project / uncategorized). */
function uniqueZipPath(relativePath, used) {
  const parts = String(relativePath || "")
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean);
  const file = sanitizeFilename(parts.pop() || "export.txt");
  const dirs = parts.map((p) => sanitizeFolder(p));
  const join = (name) => [...dirs, name].join("/");

  let candidate = join(file);
  if (!used.has(candidate)) {
    used.add(candidate);
    return candidate;
  }
  const dot = file.lastIndexOf(".");
  const stem = dot > 0 ? file.slice(0, dot) : file;
  const ext = dot > 0 ? file.slice(dot) : "";
  let i = 2;
  while (used.has(join(`${stem}-${i}${ext}`))) i += 1;
  candidate = join(`${stem}-${i}${ext}`);
  used.add(candidate);
  return candidate;
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
    await closeTrackedBulkTab();
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
    // Large single-file exports go through offscreen Blob (data: URLs break)
    if (utf8ByteLength(content) > 750_000) {
      await sendOffscreenDownload({
        base64: self.PplxExport.bytesToBase64(
          new TextEncoder().encode(content)
        ),
        filename: sanitizeFilename(filename, "perplexport.md"),
        mime: mime || "text/plain;charset=utf-8",
        saveAs: Boolean(saveAs),
      });
      return;
    }
    downloadUrl = toDataUrl(content, mime);
  } else if (typeof url === "string" && url.startsWith("data:")) {
    downloadUrl = url;
  } else {
    throw new Error("Downloads must use inline data (data: URL or content).");
  }

  const downloadId = await chrome.downloads.download({
    url: downloadUrl,
    filename: sanitizeFilename(filename, "perplexport.md"),
    saveAs: Boolean(saveAs),
  });

  await waitForDownloadOutcome(downloadId);
}

function waitForDownloadOutcome(downloadId, timeoutMs = 15 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.downloads.onChanged.removeListener(onChanged);
      fn(value);
    };

    const timer = setTimeout(() => {
      finish(reject, new Error("Download timed out waiting for completion."));
    }, timeoutMs);

    function onChanged(delta) {
      if (delta.id !== downloadId) return;
      const state = delta.state?.current;
      if (state === "complete") {
        finish(resolve, { ok: true, downloadId });
      } else if (state === "interrupted") {
        finish(reject, new Error("Download was cancelled or interrupted."));
      }
    }

    chrome.downloads.onChanged.addListener(onChanged);

    // Catch races where the download finished before the listener attached
    chrome.downloads
      .search({ id: downloadId })
      .then((items) => {
        const item = items?.[0];
        if (!item) return;
        if (item.state === "complete") {
          finish(resolve, { ok: true, downloadId });
        } else if (item.state === "interrupted") {
          finish(reject, new Error("Download was cancelled or interrupted."));
        }
      })
      .catch(() => {});
  });
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
    let objectUrl = null;
    try {
      await ensureOffscreen();
      const created = await chrome.runtime.sendMessage({
        type: "pplx-offscreen-create-url",
        base64: payload.base64,
        mime: payload.mime || "application/zip",
      });
      if (!created?.ok || !created.url) {
        throw new Error(created?.error || "Offscreen blob URL creation failed.");
      }
      objectUrl = created.url;

      // chrome.downloads is only available in the service worker — not offscreen
      const downloadId = await chrome.downloads.download({
        url: objectUrl,
        filename: sanitizeFilename(
          payload.filename,
          payload.mime?.includes("zip") ? "perplexport.zip" : "perplexport.md"
        ),
        saveAs: Boolean(payload.saveAs),
      });
      await waitForDownloadOutcome(downloadId);
      return { ok: true, downloadId };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const fatal =
        /cancelled|interrupted|Unauthorized|timed out|too large/i.test(
          lastError.message
        );
      if (fatal) throw lastError;
    } finally {
      if (objectUrl) {
        try {
          await chrome.runtime.sendMessage({
            type: "pplx-offscreen-revoke-url",
            url: objectUrl,
          });
        } catch {
          // ignore
        }
      }
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
  // Legacy key cleanup from older builds
  try {
    await chrome.storage.session.remove("pplxBulkFiles");
  } catch {
    // ignore
  }
}

async function setActiveBulkTab(tabId) {
  try {
    if (tabId == null) {
      await chrome.storage.session.remove(BULK_ACTIVE_TAB_KEY);
    } else {
      await chrome.storage.session.set({ [BULK_ACTIVE_TAB_KEY]: tabId });
    }
  } catch {
    // ignore
  }
}

async function closeTrackedBulkTab() {
  try {
    const data = await chrome.storage.session.get(BULK_ACTIVE_TAB_KEY);
    const tabId = data[BULK_ACTIVE_TAB_KEY];
    if (tabId != null) {
      try {
        await chrome.tabs.remove(tabId);
      } catch {
        // ignore
      }
    }
    await chrome.storage.session.remove(BULK_ACTIVE_TAB_KEY);
  } catch {
    // ignore
  }
}

async function readExportPayload(result) {
  if (result?.storageKey) {
    const key = String(result.storageKey);
    if (!key.startsWith(EXPORT_PAYLOAD_PREFIX)) {
      throw new Error("Invalid export payload key.");
    }
    const data = await chrome.storage.session.get(key);
    const payload = data[key];
    try {
      await chrome.storage.session.remove(key);
    } catch {
      // ignore
    }
    if (!payload?.content) {
      throw new Error("Empty export result");
    }
    return {
      content: payload.content,
      filename: payload.filename || result.filename,
    };
  }
  if (!result?.content) throw new Error("Empty export result");
  return { content: result.content, filename: result.filename };
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
  const {
    threads,
    format,
    folder,
    openerTabId,
    projectName,
    projectUrl,
    groupByProject,
  } = job;
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
    if (!force && batchBytes < BATCH_SOFT_BYTES) {
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

    // Prompt Save As for every part so later ZIPs are not silently dropped
    await downloadZip(zipFiles, zipName, true);
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
        await setActiveBulkTab(tabId);
        await waitForTabComplete(tabId);
        await sleep(800);

        const exportedRaw = await sendExport(tabId, {
          type: "pplx-export",
          action: format === "json" ? "json" : "md",
          quiet: true,
          collect: true,
          meta: {
            project: thread.projectTag || projectName || null,
            projectUrl: projectUrl || null,
            files: thread.files || [],
          },
        });
        const exported = await readExportPayload(exportedRaw);

        if (!exported?.content) {
          throw new Error("Empty export result");
        }

        const contentBytes = utf8ByteLength(exported.content);
        if (contentBytes > MAX_SESSION_EXPORT_BYTES) {
          throw new Error(
            `Thread export is too large (${(contentBytes / (1024 * 1024)).toFixed(1)} MB) to transfer safely. Skip this thread or export it alone.`
          );
        }
        if (contentBytes > MAX_ZIP_BYTES) {
          throw new Error(
            `Thread export is too large (${(contentBytes / (1024 * 1024)).toFixed(1)} MB) for a ZIP part.`
          );
        }

        // Flush before adding if this file would push past the size budget
        if (batch.length && batchBytes + contentBytes >= BATCH_SOFT_BYTES) {
          try {
            await flushBatch({ force: true, moreComing: true });
          } catch (zipErr) {
            // Keep batch in memory for failJob reporting — do not discard
            const fatal = new Error(
              zipErr?.message || "Failed to write ZIP batch."
            );
            fatal.pplxZipFlush = true;
            throw fatal;
          }
        }

        const fileName =
          exported.filename ||
          `thread-${i + 1}.${format === "json" ? "json" : "md"}`;
        const relative = groupByProject
          ? `${sanitizeFolder(
              thread.projectTag || UNCATEGORIZED_FOLDER
            )}/${fileName}`
          : fileName;
        const name = uniqueZipPath(relative, usedNames);
        batch.push({ name, content: exported.content });
        batchBytes += contentBytes;

        try {
          await flushBatch({
            moreComing: i < threads.length - 1,
          });
        } catch (zipErr) {
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
          await setActiveBulkTab(null);
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
    await closeTrackedBulkTab();
    const partial =
      zipNames.length > 0
        ? ` ${zipNames.length} ZIP part(s) were already saved (${zipNames.join(", ")}).`
        : "";
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
      new Error(`${err?.message || String(err)}${partial}`),
      openerTabId
    );
  } finally {
    bulkRunning = false;
    await setActiveBulkTab(null);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "pplx-inject-harvester") {
    (async () => {
      try {
        const tabId = sender.tab?.id;
        if (tabId == null) throw new Error("Missing tab for harvester inject.");
        if (!isTrustedExtensionSender(sender)) {
          throw new Error("Harvester inject only from Perplexity tabs.");
        }
        const token = String(message.token || "").slice(0, 80);
        if (token) {
          await chrome.scripting.executeScript({
            target: { tabId },
            world: "MAIN",
            func: (t) => {
              window.__pplxExportHarvestToken = t;
            },
            args: [token],
          });
        }
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
        if (sender.tab && !isTrustedExtensionSender(sender)) {
          throw new Error("Unauthorized download request.");
        }
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
            projectTag: t?.projectTag ? String(t.projectTag).slice(0, 120) : null,
            files: Array.isArray(t?.files)
              ? t.files.map((f) => String(f).slice(0, 240)).slice(0, 40)
              : [],
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
          projectName: message.projectName
            ? String(message.projectName).slice(0, 200)
            : null,
          projectUrl: message.projectUrl
            ? String(message.projectUrl).slice(0, 500)
            : null,
          groupByProject: Boolean(message.groupByProject),
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
