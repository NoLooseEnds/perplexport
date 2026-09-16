(() => {
  if (globalThis.__pplxExportContentLoaded) return;
  globalThis.__pplxExportContentLoaded = true;

  const FAB_ID = "pplx-export-fab";
  const MENU_ID = "pplx-export-menu";
  const TOAST_ID = "pplx-export-toast";
  const BULK_ID = "pplx-export-bulk";
  const STORAGE_KEY = "pplxDefaultFormat";
  let exporting = false;
  let defaultFormat = "md";
  let bulkBusy = false;
  let bulkListBusy = false;
  let bulkPollTimer = null;
  const BULK_JOB_KEY = "pplxBulkJob";

  function normalizeFormat(value) {
    return value === "json" ? "json" : "md";
  }

  function applyMainButton() {
    const fab = document.getElementById(FAB_ID);
    if (!fab) return;
    const main = fab.querySelector(".pplx-export-main");
    if (!main) return;
    const label = defaultFormat === "json" ? "JSON" : "Markdown";
    const span = main.querySelector("span");
    if (span) span.textContent = label;
    main.title = `Export as ${label}`;
    main.setAttribute("aria-label", `Export as ${label}`);
    main.dataset.format = defaultFormat;
  }

  async function loadDefaultFormat() {
    try {
      const data = await chrome.storage.local.get(STORAGE_KEY);
      defaultFormat = normalizeFormat(data[STORAGE_KEY]);
    } catch {
      defaultFormat = "md";
    }
    applyMainButton();
  }

  async function saveDefaultFormat(format) {
    if (format !== "md" && format !== "json") return;
    defaultFormat = format;
    applyMainButton();
    syncBulkFormatUi();
    try {
      await chrome.storage.local.set({ [STORAGE_KEY]: defaultFormat });
    } catch {
      // ignore
    }
  }

  function ensureUi() {
    const existing = document.getElementById(FAB_ID);
    if (existing) {
      const menu = existing.querySelector(`#${MENU_ID}`);
      if (menu && !menu.querySelector('[data-action="json"]')) {
        menu.innerHTML = `
          <button type="button" data-action="md">Download Markdown</button>
          <button type="button" data-action="json">Download JSON</button>
          <button type="button" data-action="copy">Copy Markdown</button>
        `;
      }
      applyMainButton();
      return;
    }

    const fab = document.createElement("div");
    fab.id = FAB_ID;
    fab.innerHTML = `
      <button type="button" class="pplx-export-main" title="Export as Markdown" aria-label="Export as Markdown" data-format="md">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path d="M12 3v12"></path>
          <path d="M7 10l5 5 5-5"></path>
          <path d="M5 19h14"></path>
        </svg>
        <span>Markdown</span>
      </button>
      <button type="button" class="pplx-export-toggle" title="More options" aria-label="More export options" aria-expanded="false">▾</button>
      <div id="${MENU_ID}" class="pplx-export-menu" hidden>
        <button type="button" data-action="md">Download Markdown</button>
        <button type="button" data-action="json">Download JSON</button>
        <button type="button" data-action="copy">Copy Markdown</button>
      </div>
    `;
    document.documentElement.appendChild(fab);

    const main = fab.querySelector(".pplx-export-main");
    const toggle = fab.querySelector(".pplx-export-toggle");
    const menu = fab.querySelector(`#${MENU_ID}`);

    main.addEventListener("click", async (e) => {
      e.stopPropagation();
      menu.setAttribute("hidden", "");
      toggle.setAttribute("aria-expanded", "false");
      await runExport(defaultFormat);
    });

    toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = menu.hasAttribute("hidden");
      if (open) {
        menu.removeAttribute("hidden");
        toggle.setAttribute("aria-expanded", "true");
      } else {
        menu.setAttribute("hidden", "");
        toggle.setAttribute("aria-expanded", "false");
      }
    });

    menu.addEventListener("click", async (e) => {
      const btn = e.target.closest("button[data-action]");
      if (!btn) return;
      menu.setAttribute("hidden", "");
      toggle.setAttribute("aria-expanded", "false");
      await runExport(btn.dataset.action);
    });

    document.addEventListener("click", (e) => {
      if (!fab.contains(e.target)) {
        menu.setAttribute("hidden", "");
        toggle.setAttribute("aria-expanded", "false");
      }
    });

    applyMainButton();
  }

  function toast(message, isError = false, sticky = false) {
    let el = document.getElementById(TOAST_ID);
    if (!el) {
      el = document.createElement("div");
      el.id = TOAST_ID;
      document.documentElement.appendChild(el);
    }
    el.textContent = message;
    el.classList.toggle("is-error", isError);
    el.classList.add("is-visible");
    clearTimeout(el._timer);
    if (!sticky) {
      el._timer = setTimeout(() => el.classList.remove("is-visible"), 2600);
    }
  }

  function setBusy(busy) {
    exporting = busy;
    const fab = document.getElementById(FAB_ID);
    if (!fab) return;
    fab.classList.toggle("is-busy", busy);
    fab.querySelectorAll("button").forEach((btn) => {
      btn.disabled = busy;
    });
  }

  function toDataUrl(content, mime) {
    const type = mime || "text/markdown;charset=utf-8";
    return `data:${type},${encodeURIComponent(content)}`;
  }

  async function downloadText(filename, content, mime, saveAs = true) {
    const url = toDataUrl(content, mime);
    const name = filename || "perplexport.md";

    try {
      const result = await chrome.runtime.sendMessage({
        type: "pplx-download",
        filename: name,
        url,
        saveAs,
      });
      if (result?.ok) return;
      throw new Error(result?.error || "Download failed.");
    } catch {
      if (!saveAs) {
        // Still try anchor fallback for bulk
      }
      const a = document.createElement("a");
      a.href = url;
      a.download = name.split("/").pop() || name;
      a.rel = "noopener";
      document.documentElement.appendChild(a);
      a.click();
      a.remove();
    }
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // fallback
    }
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }

  async function buildConversation(quiet = false) {
    if (!window.PplxExport?.loadFullConversation) {
      throw new Error("Exporter is not loaded.");
    }
    if (!PplxExport.isThreadPage()) {
      throw new Error("Open a Perplexity thread (/search/…) first.");
    }

    if (!quiet) toast("Scrolling and loading the full thread…", false, true);
    const conversation = await PplxExport.loadFullConversation({
      onProgress: ({ turns, phase }) => {
        if (!quiet && phase === "loading") {
          toast(`Loading thread… (${turns} turns found)`, false, true);
        }
      },
    });

    if (!conversation.turns.length) {
      throw new Error(
        "No questions/answers found. Wait until the thread has finished loading and try again."
      );
    }
    return conversation;
  }

  function slugifyFolder(name) {
    return (
      (name || "project")
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || "project"
    );
  }

  async function runExport(action, options = {}) {
    if (exporting) return { ok: false, error: "Export already in progress." };
    const quiet = Boolean(options.quiet);
    const collect = Boolean(options.collect);
    const saveAs = !collect && options.saveAs !== false && !quiet;
    const prefix = options.filenamePrefix || "";

    setBusy(true);
    try {
      const conversation = await buildConversation(quiet);

      if (action === "copy") {
        const md = PplxExport.toMarkdown(conversation);
        await copyText(md);
        if (!quiet) toast(`Markdown copied (${conversation.turnCount} turns)`);
        return { ok: true };
      }

      if (action === "json") {
        const json = PplxExport.toJson(conversation);
        const filename =
          prefix + PplxExport.suggestedFilename(conversation, "json");
        if (collect) {
          return { ok: true, filename, content: json, mime: "application/json" };
        }
        await downloadText(
          filename,
          json,
          "application/json;charset=utf-8",
          saveAs
        );
        if (!quiet) toast(`Downloaded ${filename}`);
        await saveDefaultFormat("json");
        return { ok: true, filename };
      }

      const md = PplxExport.toMarkdown(conversation);
      const filename =
        prefix + PplxExport.suggestedFilename(conversation, "md");
      if (collect) {
        return { ok: true, filename, content: md, mime: "text/markdown" };
      }
      await downloadText(
        filename,
        md,
        "text/markdown;charset=utf-8",
        saveAs
      );
      if (!quiet) toast(`Downloaded ${filename}`);
      await saveDefaultFormat("md");
      return { ok: true, filename };
    } catch (err) {
      console.error("[Perplexport]", err);
      const message = err.message || "Something went wrong";
      if (!quiet) toast(message, true);
      return { ok: false, error: message };
    } finally {
      setBusy(false);
    }
  }

  function setBulkRunningUi(running) {
    const panel = document.getElementById(BULK_ID);
    if (!panel) return;
    const start = panel.querySelector(".pplx-bulk-start");
    const cancel = panel.querySelector(".pplx-bulk-cancel");
    if (start) start.disabled = Boolean(running);
    if (cancel) {
      if (running) cancel.removeAttribute("hidden");
      else cancel.setAttribute("hidden", "");
      cancel.disabled = false;
    }
  }

  function stopBulkPoll() {
    if (bulkPollTimer) {
      clearInterval(bulkPollTimer);
      bulkPollTimer = null;
    }
  }

  function startBulkPoll() {
    stopBulkPoll();
    bulkPollTimer = setInterval(syncBulkJobFromStorage, 3000);
  }

  async function syncBulkJobFromStorage() {
    if (!bulkBusy) {
      stopBulkPoll();
      return;
    }
    try {
      const status = await chrome.runtime.sendMessage({ type: "pplx-bulk-status" });
      const job = status?.job;
      if (!job) return;
      if (job.status === "done") {
        onBulkProgress({
          status: "done",
          done: job.done,
          failed: job.failed,
          total: job.total,
          errors: job.errors,
          zipName: job.zipName,
          zipNames: job.zipNames,
          collected: job.collected,
        });
      } else if (job.status === "error" || job.status === "cancelled") {
        onBulkProgress({
          status: job.status,
          error: job.error || "Bulk failed",
          done: job.done,
          failed: job.failed,
          total: job.total,
          errors: job.errors,
          zipNames: job.zipNames,
          zipName: job.zipName,
        });
      } else if (job.status === "running" && status.running) {
        onBulkProgress({
          status: "tick",
          done: job.done,
          failed: job.failed,
          total: job.total,
          collected: job.collected,
          zipNames: job.zipNames,
          current: "…",
        });
      } else if (job.status === "running" && !status.running) {
        onBulkProgress({
          status: "error",
          error: "Bulk export was interrupted.",
          done: job.done,
          failed: job.failed,
          total: job.total,
          zipNames: job.zipNames,
        });
      }
    } catch {
      // ignore
    }
  }

  async function cancelBulkExport() {
    try {
      await chrome.runtime.sendMessage({ type: "pplx-bulk-cancel" });
      const panel = document.getElementById(BULK_ID);
      const status = panel?.querySelector(".pplx-bulk-status");
      if (status) status.textContent = "Cancelling after current thread…";
      const cancel = panel?.querySelector(".pplx-bulk-cancel");
      if (cancel) cancel.disabled = true;
    } catch (err) {
      toast(err?.message || "Could not cancel", true);
    }
  }

  function getPageKind() {
    const path = location.pathname || "";
    if (/\/search\//.test(path) || /\/page\//.test(path)) return "thread";
    if (/\/projects\/[^/]+/.test(path) || /^\/library\/?$/.test(path)) return "bulk";
    return "other";
  }

  function removeBulkUi() {
    const bulk = document.getElementById(BULK_ID);
    if (bulk) bulk.remove();
  }

  function ensureBulkUi() {
    const kind = getPageKind();
    const keepAlive = bulkListBusy || bulkBusy;
    let panel = document.getElementById(BULK_ID);

    if (panel && (kind === "bulk" || keepAlive)) {
      const launch = panel.querySelector(".pplx-bulk-launch");
      if (launch && !launch.querySelector("svg")) {
        launch.innerHTML = `
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path d="M12 3v12"></path>
            <path d="M7 10l5 5 5-5"></path>
            <path d="M5 19h14"></path>
          </svg>
          <span>Bulk</span>
        `;
      }
      const actions = panel.querySelector(".pplx-bulk-actions");
      if (actions && !panel.querySelector(".pplx-bulk-cancel")) {
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.className = "pplx-bulk-cancel";
        cancel.textContent = "Cancel";
        cancel.setAttribute("hidden", "");
        cancel.addEventListener("click", () => cancelBulkExport());
        actions.appendChild(cancel);
      }
      ensureBulkProgressEl(panel);
      return panel;
    }

    if (kind !== "bulk") return null;
    if (panel) return panel;

    panel = document.createElement("div");
    panel.id = BULK_ID;
    panel.innerHTML = `
      <button type="button" class="pplx-bulk-launch" title="Bulk export threads" aria-label="Bulk export">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path d="M12 3v12"></path>
          <path d="M7 10l5 5 5-5"></path>
          <path d="M5 19h14"></path>
        </svg>
        <span>Bulk</span>
      </button>
      <div class="pplx-bulk-panel" hidden>
        <header>
          <strong>Bulk export</strong>
          <button type="button" class="pplx-bulk-close" aria-label="Close">×</button>
        </header>
        <p class="pplx-bulk-status">Finding threads…</p>
        <div class="pplx-bulk-progress" aria-hidden="true">
          <div class="pplx-bulk-progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" aria-label="Export progress">
            <div class="pplx-bulk-progress-bar"></div>
          </div>
          <span class="pplx-bulk-progress-label">0%</span>
        </div>
        <div class="pplx-bulk-meta"></div>
        <div class="pplx-bulk-format" role="group" aria-label="Export format">
          <button type="button" class="pplx-bulk-format-btn" data-format="md">Markdown</button>
          <button type="button" class="pplx-bulk-format-btn" data-format="json">JSON</button>
        </div>
        <div class="pplx-bulk-list"></div>
        <div class="pplx-bulk-actions">
          <button type="button" class="pplx-bulk-refresh">Refresh list</button>
          <button type="button" class="pplx-bulk-resolve">Find missing</button>
          <button type="button" class="pplx-bulk-start">Start export</button>
          <button type="button" class="pplx-bulk-cancel" hidden>Cancel</button>
        </div>
        <p class="pplx-bulk-hint">Choose a format, then start. Large exports auto-split into several <strong>ZIP</strong>s (about 30 threads or ~12&nbsp;MB each). “Find missing” briefly opens rows without links; the panel stays open while that runs.</p>
      </div>
    `;
    document.documentElement.appendChild(panel);

    const launch = panel.querySelector(".pplx-bulk-launch");
    const sheet = panel.querySelector(".pplx-bulk-panel");
    const close = panel.querySelector(".pplx-bulk-close");
    const refresh = panel.querySelector(".pplx-bulk-refresh");
    const resolve = panel.querySelector(".pplx-bulk-resolve");
    const start = panel.querySelector(".pplx-bulk-start");
    const cancel = panel.querySelector(".pplx-bulk-cancel");

    panel.querySelectorAll(".pplx-bulk-format-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        await saveDefaultFormat(btn.dataset.format);
        syncBulkFormatUi();
      });
    });

    launch.addEventListener("click", async (e) => {
      e.stopPropagation();
      sheet.removeAttribute("hidden");
      syncBulkFormatUi();
      await refreshBulkList();
    });
    close.addEventListener("click", () => {
      if (bulkListBusy || bulkBusy) return;
      sheet.setAttribute("hidden", "");
    });
    refresh.addEventListener("click", () => refreshBulkList());
    resolve.addEventListener("click", () => refreshBulkList({ resolveMissing: true }));
    start.addEventListener("click", () => startBulkExport());
    cancel.addEventListener("click", () => cancelBulkExport());

    syncBulkFormatUi();
    return panel;
  }

  function getBulkFormat() {
    const panel = document.getElementById(BULK_ID);
    const active = panel?.querySelector(".pplx-bulk-format-btn.is-active");
    return normalizeFormat(active?.dataset.format || defaultFormat);
  }

  function syncBulkFormatUi() {
    const panel = document.getElementById(BULK_ID);
    if (!panel) return;
    // Upgrade older injected panel without format controls
    if (!panel.querySelector(".pplx-bulk-format")) {
      const meta = panel.querySelector(".pplx-bulk-meta");
      const format = document.createElement("div");
      format.className = "pplx-bulk-format";
      format.setAttribute("role", "group");
      format.setAttribute("aria-label", "Export format");
      format.innerHTML = `
        <button type="button" class="pplx-bulk-format-btn" data-format="md">Markdown</button>
        <button type="button" class="pplx-bulk-format-btn" data-format="json">JSON</button>
      `;
      meta?.after(format);
      format.querySelectorAll(".pplx-bulk-format-btn").forEach((btn) => {
        btn.addEventListener("click", async () => {
          await saveDefaultFormat(btn.dataset.format);
          syncBulkFormatUi();
        });
      });
    }
    panel.querySelectorAll(".pplx-bulk-format-btn").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.format === defaultFormat);
    });
    const meta = panel.querySelector(".pplx-bulk-meta");
    const projectName = panel._bulkData?.project?.name;
    if (meta && projectName) {
      meta.textContent = projectName;
    }
  }

  function truncateLabel(text, max = 90) {
    const t = (text || "").replace(/\s+/g, " ").trim();
    return t.length > max ? `${t.slice(0, max)}…` : t;
  }

  function cleanBulkTitle(title) {
    const t = (title || "").replace(/\s+/g, " ").trim();
    if (!t) return "";
    if (t.startsWith("/search/")) return "";
    if (/^https?:\/\/(?:www\.)?perplexity\.ai\/search\//i.test(t)) return "";
    return t;
  }

  async function refreshBulkList(options = {}) {
    const panel = ensureBulkUi();
    if (!panel) return;
    const status = panel.querySelector(".pplx-bulk-status");
    const list = panel.querySelector(".pplx-bulk-list");
    const sheet = panel.querySelector(".pplx-bulk-panel");
    const start = panel.querySelector(".pplx-bulk-start");
    const resolveBtn = panel.querySelector(".pplx-bulk-resolve");
    const refreshBtn = panel.querySelector(".pplx-bulk-refresh");

    bulkListBusy = true;
    panel.classList.add("is-busy");
    sheet?.removeAttribute("hidden");
    syncVisibility();
    status.textContent = options.resolveMissing
      ? "Fetching missing links (brief navigation)…"
      : "Scrolling the Sessions list…";
    list.innerHTML = "";
    start.disabled = true;
    if (resolveBtn) resolveBtn.disabled = true;
    if (refreshBtn) refreshBtn.disabled = true;
    setBulkProgress({
      visible: true,
      indeterminate: true,
      current: 0,
      total: 0,
    });

    try {
      const result = await PplxExport.listProjectThreads({
        resolveMissing: Boolean(options.resolveMissing),
        onProgress: ({ rows, withUrl, phase, idle, idleNeeded }) => {
          const counts =
            typeof withUrl === "number"
              ? `${withUrl} with links · ${rows} total`
              : `${rows} unique`;
          if (phase === "waiting") {
            const left = Math.max((idleNeeded || 0) - (idle || 0), 0);
            status.textContent = `Waiting for more… (${counts}${
              left ? ` · finish in ~${left}` : ""
            })`;
          } else {
            status.textContent = `Loading sessions… (${counts})`;
          }
          setBulkProgress({
            visible: true,
            indeterminate: true,
            current: rows,
            total: Math.max(rows, 1),
          });
        },
        onResolveProgress: ({ index, total, title }) => {
          // Stay pinned while SPA hops briefly leave /library
          syncVisibility();
          const live = document.getElementById(BULK_ID);
          const liveStatus = live?.querySelector(".pplx-bulk-status");
          if (liveStatus) {
            liveStatus.textContent = `Fetching link ${index + 1}/${total}: ${truncateLabel(title, 40)}`;
          }
          setBulkProgress({
            visible: true,
            current: index + 1,
            total,
          });
        },
      });

      // Re-bind after possible SPA navigations during Find missing
      const live = document.getElementById(BULK_ID) || ensureBulkUi();
      if (!live) return;
      const liveStatus = live.querySelector(".pplx-bulk-status") || status;
      const liveList = live.querySelector(".pplx-bulk-list") || list;
      const liveStart = live.querySelector(".pplx-bulk-start") || start;
      const liveResolve = live.querySelector(".pplx-bulk-resolve") || resolveBtn;

      live._bulkData = result;
      syncBulkFormatUi();
      const metaEl = live.querySelector(".pplx-bulk-meta");
      if (metaEl) metaEl.textContent = result.project.name;
      setBulkProgress({ visible: false });

      if (!result.threads.length && !result.missing?.length) {
        liveStatus.textContent = "No threads found in the Sessions table.";
        if (liveResolve) liveResolve.disabled = false;
        return;
      }

      const missing = result.missing || [];
      liveStatus.textContent =
        `${result.threads.length} threads with links` +
        (missing.length
          ? ` · ${missing.length} without links (use Find missing — Library hides most URLs in the DOM)`
          : "");

      const labelFor = (t) => {
        const raw = cleanBulkTitle(t?.title);
        if (raw) return truncateLabel(raw).replace(/</g, "&lt;");
        const id = String(t?.url || "")
          .replace(/^\/search\//, "")
          .slice(0, 8);
        return id ? `Untitled (${id}…)` : "Untitled thread";
      };

      const readyItems = result.threads.map((t, i) => {
        const date = (t.date || "").slice(0, 10);
        const title = labelFor(t);
        const dateHtml = date
          ? `<em>${date}</em>`
          : `<em class="is-empty">No date</em>`;
        return `<label class="pplx-bulk-item"><input type="checkbox" data-index="${i}" checked /><span class="pplx-bulk-item-text"><strong>${title}</strong>${dateHtml}</span></label>`;
      });

      const missingItems = missing.map((t) => {
        const date = (t.date || "").slice(0, 10);
        const title = labelFor(t);
        const dateHtml = date
          ? `<em>${date}</em>`
          : `<em class="is-empty">No date</em>`;
        return `<label class="pplx-bulk-item is-missing"><input type="checkbox" disabled /><span class="pplx-bulk-item-text"><strong>${title}</strong>${dateHtml} <small>(no link)</small></span></label>`;
      });

      liveList.innerHTML = [...readyItems, ...missingItems].join("");
      liveStart.disabled = !result.threads.length;
      if (liveResolve) liveResolve.disabled = !missing.length;
      const liveRefresh = live?.querySelector(".pplx-bulk-refresh");
      if (liveRefresh) liveRefresh.disabled = false;
    } catch (err) {
      const live = document.getElementById(BULK_ID);
      const liveStatus = live?.querySelector(".pplx-bulk-status");
      if (liveStatus) liveStatus.textContent = err.message || "Could not load threads";
      const liveResolve = live?.querySelector(".pplx-bulk-resolve");
      if (liveResolve) liveResolve.disabled = false;
      const liveRefresh = live?.querySelector(".pplx-bulk-refresh");
      if (liveRefresh) liveRefresh.disabled = false;
    } finally {
      bulkListBusy = false;
      const live = document.getElementById(BULK_ID);
      live?.classList.remove("is-busy");
      syncVisibility();
    }
  }

  async function startBulkExport() {
    if (bulkBusy) return;
    const panel = ensureBulkUi();
    if (!panel) return;
    const data = panel._bulkData;
    if (!data?.threads?.length) {
      toast("No threads in the list", true);
      return;
    }

    const selected = Array.from(
      panel.querySelectorAll('.pplx-bulk-list input[type="checkbox"]:checked')
    ).map((el) => data.threads[Number(el.dataset.index)])
      .filter(Boolean);

    if (!selected.length) {
      toast("Select at least one thread", true);
      return;
    }

    bulkBusy = true;
    setBulkRunningUi(true);
    startBulkPoll();
    const status = panel.querySelector(".pplx-bulk-status");
    status.textContent = `Starting bulk (${selected.length})…`;
    setBulkProgress({ current: 0, total: selected.length, visible: true });

    try {
      const folder = slugifyFolder(data.project.name);
      const format = getBulkFormat();
      await saveDefaultFormat(format);
      const result = await chrome.runtime.sendMessage({
        type: "pplx-bulk-start",
        threads: selected,
        format,
        folder,
      });
      if (!result?.ok) throw new Error(result?.error || "Bulk start failed");
      status.textContent = `Exporting 0/${selected.length}…`;
      toast(`Bulk started (${selected.length} threads, ${format})`);
    } catch (err) {
      status.textContent = err.message || "Bulk failed";
      toast(err.message || "Bulk failed", true);
      bulkBusy = false;
      setBulkRunningUi(false);
      stopBulkPoll();
      setBulkProgress({ visible: false });
    }
  }

  function ensureBulkProgressEl(panel) {
    let wrap = panel.querySelector(".pplx-bulk-progress");
    if (wrap) return wrap;
    const status = panel.querySelector(".pplx-bulk-status");
    wrap = document.createElement("div");
    wrap.className = "pplx-bulk-progress";
    wrap.setAttribute("aria-hidden", "true");
    wrap.innerHTML = `
      <div class="pplx-bulk-progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" aria-label="Export progress">
        <div class="pplx-bulk-progress-bar"></div>
      </div>
      <span class="pplx-bulk-progress-label">0%</span>
    `;
    status?.after(wrap);
    return wrap;
  }

  function setBulkProgress({
    current = 0,
    total = 0,
    visible = true,
    indeterminate = false,
  } = {}) {
    const panel = document.getElementById(BULK_ID);
    if (!panel) return;
    const wrap = ensureBulkProgressEl(panel);
    // Drop legacy hidden attr from older builds
    wrap.removeAttribute("hidden");
    const track = wrap.querySelector(".pplx-bulk-progress-track");
    const bar = wrap.querySelector(".pplx-bulk-progress-bar");
    const label = wrap.querySelector(".pplx-bulk-progress-label");

    wrap.classList.toggle("is-visible", Boolean(visible));
    wrap.classList.toggle("is-indeterminate", Boolean(indeterminate));
    wrap.setAttribute("aria-hidden", visible ? "false" : "true");

    if (!visible) return;

    const safeTotal = Math.max(0, Number(total) || 0);
    const safeCurrent = Math.max(0, Number(current) || 0);
    const pct =
      indeterminate || !safeTotal
        ? 0
        : Math.max(0, Math.min(100, Math.round((safeCurrent / safeTotal) * 100)));

    if (bar) bar.style.width = indeterminate ? "40%" : `${pct}%`;
    if (track) {
      track.setAttribute("aria-valuenow", String(indeterminate ? 0 : pct));
      track.setAttribute("aria-valuemax", "100");
    }
    if (label) {
      label.textContent = indeterminate
        ? "…"
        : `${pct}% · ${Math.min(safeCurrent, safeTotal)}/${safeTotal || "?"}`;
    }
  }

  function onBulkProgress(message) {
    const panel = document.getElementById(BULK_ID);
    if (!panel) return;
    const status = panel.querySelector(".pplx-bulk-status");
    if (!status) return;

    if (message.status === "done") {
      bulkBusy = false;
      setBulkRunningUi(false);
      stopBulkPoll();
      setBulkProgress({
        current: message.total || message.done || 0,
        total: message.total || message.done || 1,
        visible: true,
      });
      const zips = message.zipNames?.length
        ? message.zipNames
        : message.zipName
          ? [message.zipName]
          : [];
      let text =
        `Done: ${message.done}/${message.total} OK` +
        (message.failed ? `, ${message.failed} failed` : "");
      if (zips.length === 1) text += ` · ${zips[0]}`;
      else if (zips.length > 1) text += ` · ${zips.length} ZIPs`;
      if (message.errors?.length) {
        const first = message.errors[0];
        text += ` · e.g. ${String(first.error || "").slice(0, 80)}`;
      }
      status.textContent = text;
      toast(text, Boolean(message.failed));
      return;
    }
    if (message.status === "zipping") {
      status.textContent = message.part
        ? `Packing ZIP part ${message.part} (${message.collected || message.done} files)…`
        : `Packing ZIP (${message.collected || message.done} files)…`;
      setBulkProgress({
        current: message.total || message.done || 0,
        total: message.total || message.done || 1,
        visible: true,
        indeterminate: true,
      });
      return;
    }
    if (message.status === "error" || message.status === "cancelled") {
      bulkBusy = false;
      setBulkRunningUi(false);
      stopBulkPoll();
      setBulkProgress({ visible: false });
      status.textContent =
        message.status === "cancelled"
          ? message.error || "Cancelled"
          : message.error || "Bulk failed";
      toast(status.textContent, true);
      return;
    }

    const total = message.total || 0;
    const current =
      message.status === "loading" && typeof message.index === "number"
        ? message.index + 1
        : Math.min((message.done || 0) + (message.status === "loading" ? 1 : 0), total);

    setBulkProgress({ current, total, visible: true });

    status.textContent =
      `Exporting ${message.done}/${message.total}` +
      (message.failed ? ` · ${message.failed} errors` : "") +
      (message.current ? ` · ${String(message.current).slice(0, 48)}` : "");
    if (message.status === "loading" && typeof message.index === "number") {
      status.textContent =
        `Exporting ${message.index + 1}/${message.total}` +
        (message.current ? ` · ${String(message.current).slice(0, 48)}` : "");
    }
  }

  function syncVisibility() {
    const kind = getPageKind();
    const keepBulkAlive = bulkListBusy || bulkBusy;
    const showFab = kind === "thread" && !keepBulkAlive;
    const showBulk = kind === "bulk" || keepBulkAlive;

    if (showFab) {
      ensureUi();
      const fab = document.getElementById(FAB_ID);
      if (fab) {
        fab.classList.remove("is-hidden");
        fab.removeAttribute("hidden");
      }
    } else {
      const fab = document.getElementById(FAB_ID);
      if (fab) {
        fab.classList.add("is-hidden");
        fab.setAttribute("hidden", "");
      }
    }

    if (showBulk) {
      const bulk =
        document.getElementById(BULK_ID) ||
        (kind === "bulk" ? ensureBulkUi() : null);
      if (bulk) {
        bulk.classList.remove("is-hidden");
        bulk.removeAttribute("hidden");
        if (keepBulkAlive) {
          bulk.classList.add("is-busy");
          bulk.querySelector(".pplx-bulk-panel")?.removeAttribute("hidden");
        } else {
          bulk.classList.remove("is-busy");
        }
      }
    } else {
      removeBulkUi();
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "pplx-bulk-progress") {
      onBulkProgress(message);
      return;
    }
    if (message?.type !== "pplx-export") return;
    (async () => {
      const action = message.action || defaultFormat;
      const result = await runExport(action, {
        saveAs: message.saveAs,
        filenamePrefix: message.filenamePrefix,
        quiet: message.quiet,
        collect: message.collect,
      });
      sendResponse(result);
    })();
    return true;
  });

  let lastHref = location.href;
  const mo = new MutationObserver(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      syncVisibility();
    }
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });

  window.addEventListener("popstate", syncVisibility);

  ["pushState", "replaceState"].forEach((method) => {
    const original = history[method];
    if (typeof original !== "function") return;
    history[method] = function (...args) {
      const result = original.apply(this, args);
      queueMicrotask(() => {
        if (location.href !== lastHref) {
          lastHref = location.href;
          syncVisibility();
        }
      });
      return result;
    };
  });

  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      syncVisibility();
    }
  }, 1000);

  // Recover UI if a previous bulk job was interrupted or still running.
  // Ping the worker first so stale "running" jobs get reconciled after SW restart.
  (async () => {
    try {
      const status = await chrome.runtime.sendMessage({ type: "pplx-bulk-status" });
      const job = status?.job;
      if (!job) return;
      if (getPageKind() !== "bulk") {
        syncVisibility();
        return;
      }
      ensureBulkUi();
      if (job.status === "running" && status.running) {
        bulkBusy = true;
        setBulkRunningUi(true);
        startBulkPoll();
        onBulkProgress({
          status: "tick",
          done: job.done,
          failed: job.failed,
          total: job.total,
          collected: job.collected,
          current: "Resuming status…",
        });
      } else if (job.status === "running" && !status.running) {
        // Worker has no live job — treat as interrupted locally
        onBulkProgress({
          status: "error",
          error: "Bulk export was interrupted.",
          done: job.done,
          failed: job.failed,
          total: job.total,
        });
      } else if (job.status === "error" || job.status === "cancelled") {
        const finished = Date.parse(job.finishedAt || "") || 0;
        if (Date.now() - finished < 2 * 60 * 1000) {
          onBulkProgress({
            status: job.status,
            error: job.error,
            done: job.done,
            failed: job.failed,
            total: job.total,
            errors: job.errors,
          });
        }
      }
    } catch {
      // ignore
    }
    syncVisibility();
  })();

  syncVisibility();
  loadDefaultFormat().then(syncVisibility);
})();
