(() => {
  const ROOT = typeof globalThis !== "undefined" ? globalThis : window;
  const api = (ROOT.PplxExport = ROOT.PplxExport || {});

  function cleanText(value) {
    return (value || "")
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function isProjectPage(doc = document) {
    const path =
      (typeof location !== "undefined" && location.pathname) ||
      doc.location?.pathname ||
      "";
    return /\/projects\/[^/]+/.test(path);
  }

  function isLibraryPage(doc = document) {
    const path =
      (typeof location !== "undefined" && location.pathname) ||
      doc.location?.pathname ||
      "";
    return /^\/library\/?$/.test(path);
  }

  /** Project Sessions or the global Library list. */
  function isBulkListPage(doc = document) {
    return isProjectPage(doc) || isLibraryPage(doc);
  }

  function getProjectInfo(doc = document) {
    const path =
      (typeof location !== "undefined" && location.pathname) || "";
    const match = path.match(/\/projects\/([^/]+)/);
    const slug = match ? decodeURIComponent(match[1]) : "project";
    const nameFromSlug = slug.replace(/-[A-Za-z0-9._]{10,}$/, "").replace(/-/g, " ");
    const title = cleanText(doc.querySelector("title")?.textContent || "");
    const name = (title || nameFromSlug || "project")
      .replace(/\s*[·|–—-]\s*Perplexity.*$/i, "")
      .trim();
    return { slug, name, path, kind: "project" };
  }

  function getBulkSourceInfo(doc = document) {
    if (isLibraryPage(doc)) {
      return {
        slug: "library",
        name: "Library",
        path: "/library",
        kind: "library",
      };
    }
    return getProjectInfo(doc);
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function isScrollable(el) {
    if (!el || el === document.body || el === document.documentElement) {
      return false;
    }
    const style = window.getComputedStyle(el);
    if (!/(auto|scroll|overlay)/.test(style.overflowY)) return false;
    return el.scrollHeight > el.clientHeight + 20;
  }

  function hasYScrollPotential(el) {
    if (!el || el === document.body || el === document.documentElement) {
      return false;
    }
    const style = window.getComputedStyle(el);
    return /(auto|scroll|overlay)/.test(style.overflowY);
  }

  function findScrollParent(el) {
    let node = el;
    while (node && node !== document.documentElement) {
      if (isScrollable(node) || hasYScrollPotential(node)) return node;
      node = node.parentElement;
    }
    return null;
  }

  /** Prefer nested list viewports (Radix, etc.) — never the document itself. */
  function findListScrollers(table, doc = document) {
    const found = [];
    const add = (el) => {
      if (el && !found.includes(el) && hasYScrollPotential(el)) found.push(el);
    };

    doc
      .querySelectorAll("main [data-radix-scroll-area-viewport]")
      .forEach((el) => add(el));
    add(table?.closest?.("[data-radix-scroll-area-viewport]"));
    add(table?.querySelector?.("[data-radix-scroll-area-viewport]"));
    add(findScrollParent(table));
    add(doc.querySelector("main"));

    let node = table?.parentElement;
    while (node && node !== doc.documentElement) {
      add(node);
      node = node.parentElement;
    }

    found.sort(
      (a, b) =>
        b.scrollHeight - b.clientHeight - (a.scrollHeight - a.clientHeight)
    );
    return found;
  }

  function absoluteSearchUrl(href) {
    if (!href) return null;
    try {
      const url = new URL(href, location.origin);
      if (!url.pathname.startsWith("/search/")) return null;
      return url.pathname + url.search;
    } catch {
      return null;
    }
  }

  function walkFiberForUrl(startEl) {
    if (!startEl) return null;
    const propsKey = Object.keys(startEl).find((k) =>
      k.startsWith("__reactProps$")
    );
    if (propsKey) {
      const found = digForSearchUrl(startEl[propsKey], 0);
      if (found) return found;
    }
    const fiberKey = Object.keys(startEl).find(
      (k) =>
        k.startsWith("__reactFiber$") ||
        k.startsWith("__reactInternalInstance$")
    );
    if (!fiberKey) return null;

    // Walk ancestors only — a full child BFS freezes Library scrolling
    let fiber = startEl[fiberKey];
    for (let depth = 0; depth < 40 && fiber; depth += 1, fiber = fiber.return) {
      const bags = [fiber.memoizedProps, fiber.pendingProps];
      for (const bag of bags) {
        const found = digForSearchUrl(bag, 0);
        if (found) return found;
      }
    }
    return null;
  }

  function digForSearchUrl(value, depth) {
    if (depth > 5 || value == null) return null;
    if (typeof value === "string") {
      if (value.includes("/search/")) return absoluteSearchUrl(value);
      if (
        /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
          value
        )
      ) {
        return `/search/${value}`;
      }
      return null;
    }
    if (typeof value !== "object") return null;
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 25)) {
        const found = digForSearchUrl(item, depth + 1);
        if (found) return found;
      }
      return null;
    }

    const preferredKeys = [
      "href",
      "url",
      "threadUrl",
      "permalink",
      "slug",
      "thread_slug",
      "url_slug",
      "uuid",
      "thread_id",
      "threadId",
      "entry_uuid",
      "entryUuid",
      "backend_uuid",
      "backendUuid",
      "context_uuid",
      "contextUuid",
      "id",
      "entry",
      "session",
      "context",
      "thread",
      "item",
      "data",
    ];
    for (const key of preferredKeys) {
      if (key in value) {
        const found = digForSearchUrl(value[key], depth + 1);
        if (found) return found;
      }
    }

    // Shallow fallback only — avoid walking huge React trees every scroll tick
    if (depth >= 2) return null;
    for (const key of Object.keys(value).slice(0, 25)) {
      if (typeof value[key] === "function") continue;
      const found = digForSearchUrl(value[key], depth + 1);
      if (found) return found;
    }
    return null;
  }

  function normalizeTitleKey(title) {
    return cleanText(title || "")
      .toLowerCase()
      .slice(0, 80);
  }

  /** Merge threads by URL and title so virtualized re-renders don't inflate counts. */
  function createThreadStore() {
    const byUrl = new Map();
    const byTitle = new Map();

    const upsert = (item) => {
      if (!item?.url && !item?.title) return;
      const titleKey = normalizeTitleKey(item.title);
      const existingByUrl = item.url ? byUrl.get(item.url) : null;
      const existingByTitle = titleKey ? byTitle.get(titleKey) : null;
      const prev = existingByUrl || existingByTitle || null;
      const merged = {
        url: item.url || prev?.url || null,
        title: item.title || prev?.title || null,
        date: item.date || prev?.date || null,
        row: item.row || prev?.row || null,
      };

      if (prev) {
        if (prev.url && prev.url !== merged.url) {
          byUrl.delete(prev.url);
        }
        const prevTitle = normalizeTitleKey(prev.title);
        if (prevTitle && prevTitle !== titleKey) byTitle.delete(prevTitle);
      }

      if (merged.url) byUrl.set(merged.url, merged);
      if (titleKey) byTitle.set(titleKey, merged);
    };

    const values = () => {
      const out = new Map();
      for (const t of byUrl.values()) {
        out.set(t.url || `title:${normalizeTitleKey(t.title)}`, t);
      }
      for (const t of byTitle.values()) {
        if (t.url && byUrl.has(t.url)) continue;
        out.set(`title:${normalizeTitleKey(t.title)}`, t);
      }
      return Array.from(out.values());
    };

    return { upsert, values };
  }

  function harvestSearchUrlsFromJson(data, into, depth = 0) {
    if (depth > 10 || data == null) return;
    if (typeof data === "string") {
      if (data.includes("/search/")) {
        const url = absoluteSearchUrl(data);
        if (url) into.add(url);
      } else if (
        /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
          data
        )
      ) {
        into.add(`/search/${data}`);
      }
      return;
    }
    if (typeof data !== "object") return;
    if (Array.isArray(data)) {
      data
        .slice(0, 200)
        .forEach((item) => harvestSearchUrlsFromJson(item, into, depth + 1));
      return;
    }

    for (const key of Object.keys(data).slice(0, 80)) {
      harvestSearchUrlsFromJson(data[key], into, depth + 1);
    }
  }

  /**
   * Hook page-world fetch/XHR while scrolling Library so list API payloads
   * yield /search/ UUIDs (rows themselves usually have no href).
   */
  function installNetworkHarvester() {
    const harvested = new Map(); // titleKey -> url
    const titleByUrl = new Map(); // url -> original title
    const urls = new Set();

    const rememberPair = (rawTitle, rawUrl) => {
      const title = cleanText(rawTitle || "");
      const url = absoluteSearchUrl(rawUrl) || rawUrl;
      if (!title || !url?.startsWith("/search/")) return;
      urls.add(url);
      harvested.set(normalizeTitleKey(title), url);
      if (!titleByUrl.has(url)) titleByUrl.set(url, title);
    };

    const onMessage = (event) => {
      if (event.source !== window) return;
      const msg = event.data;
      if (!msg || msg.type !== "__pplxExportHarvest") return;
      try {
        const payload = msg.payload;
        if (msg.kind === "pair" && msg.title && msg.url) {
          rememberPair(msg.title, msg.url);
          return;
        }
        const bucket = new Set();
        harvestSearchUrlsFromJson(payload, bucket);
        bucket.forEach((u) => urls.add(u));
        // Prefer title/id pairs — bare UUIDs alone never become list rows
        walkPairs(payload, 0);
      } catch {
        // ignore
      }
    };

    function walkPairs(data, depth) {
      if (depth > 10 || !data || typeof data !== "object") return;
      if (Array.isArray(data)) {
        data.slice(0, 200).forEach((item) => walkPairs(item, depth + 1));
        return;
      }
      const title =
        data.title ||
        data.name ||
        data.query ||
        data.first_query ||
        data.thread_title ||
        null;
      const idCandidates = [
        data.uuid,
        data.entry_uuid,
        data.context_uuid,
        data.backend_uuid,
        data.thread_id,
        data.threadId,
        data.entryUuid,
        data.contextUuid,
        typeof data.id === "string" ? data.id : null,
      ];
      if (typeof title === "string") {
        for (const id of idCandidates) {
          if (typeof id === "string" && /^[a-f0-9-]{36}$/i.test(id)) {
            rememberPair(title, `/search/${id}`);
            break;
          }
        }
      }
      Object.keys(data)
        .slice(0, 80)
        .forEach((k) => walkPairs(data[k], depth + 1));
    }

    window.addEventListener("message", onMessage);

    // Inject via extension scripting API (MAIN world) — inline <script> is blocked by CSP
    const inject = chrome?.runtime?.sendMessage?.({
      type: "pplx-inject-harvester",
    });
    if (inject && typeof inject.then === "function") {
      // fire-and-forget; caller may await installNetworkHarvester's promise wrapper
      inject.catch(() => {});
    }

    return {
      urls,
      byTitle: harvested,
      titleByUrl,
      ready: inject && typeof inject.then === "function" ? inject : Promise.resolve(),
      stop() {
        window.removeEventListener("message", onMessage);
      },
    };
  }

  function findSessionsTable(doc = document) {
    // IMPORTANT: aria-label="Sessions" alone matches the sidebar /library link first.
    const exact = doc.querySelector('[role="table"][aria-label="Sessions"]');
    if (exact) return exact;

    const tables = Array.from(doc.querySelectorAll('[role="table"]'));
    const byLabel = tables.find((el) =>
      /session/i.test(el.getAttribute("aria-label") || "")
    );
    if (byLabel) return byLabel;

    // Prefer a table that already contains data rows
    const withRows = tables.find(
      (el) =>
        el.querySelector('[class*="data-table-row"]') ||
        el.querySelector('[role="row"]')
    );
    if (withRows) return withRows;

    // Fallback: nearest common ancestor of data-table rows in main
    const row = doc.querySelector(
      'main [class*="data-table-row"], [class*="group/data-table-row"], [class*="data-table-row"]'
    );
    if (row) {
      return (
        row.closest('[role="table"]') ||
        row.closest('[class*="grid-cols-subgrid"]') ||
        row.parentElement
      );
    }
    return null;
  }

  function findSessionRows(root) {
    if (!root) return [];
    const rows = Array.from(
      root.querySelectorAll(
        '[class*="data-table-row"][role="row"], [class*="data-table-row"], [role="row"]'
      )
    );
    // Prefer explicit data-table rows when present
    const dataRows = rows.filter((el) =>
      String(el.className || "").includes("data-table-row")
    );
    return (dataRows.length ? dataRows : rows).filter((el) => {
      // Skip header-like rows with no title/time
      const hasTime = Boolean(el.querySelector("time"));
      const hasCells = el.querySelectorAll('[role="cell"]').length >= 2;
      return hasTime || hasCells;
    });
  }

  function rowTitle(row) {
    const cells = row.querySelectorAll('[role="cell"]');
    if (cells.length >= 2) {
      const fromCell = cleanText(cells[1].innerText || cells[1].textContent)
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l.length >= 8);
      if (fromCell) return fromCell;
    }

    const candidates = Array.from(row.querySelectorAll('[role="cell"], span, div'))
      .map((el) => cleanText(el.innerText || el.textContent))
      .filter((t) => t.length >= 12)
      .filter((t) => !/^\d{1,2}[./]\d{1,2}/.test(t))
      .filter((t) => !/^(Search|Private|Public|Library|Session options|\d+mo ago|\d+d ago)$/i.test(t));

    if (candidates.length) {
      return candidates.sort((a, b) => a.length - b.length)[0].split("\n")[0].trim();
    }
    return cleanText(row.innerText).split("\n").map((l) => l.trim()).find((l) => l.length >= 12) || null;
  }

  function buildTitleIndex(doc) {
    const map = new Map();
    doc.querySelectorAll('a[href^="/search/"]').forEach((a) => {
      const href = absoluteSearchUrl(a.getAttribute("href"));
      if (!href) return;
      const label = cleanText(
        a.getAttribute("aria-label") || a.innerText || a.textContent
      );
      if (!label) return;
      map.set(label, href);
      map.set(label.slice(0, 80), href);
      map.set(label.slice(0, 40), href);
      map.set(label.slice(0, 24), href);
    });
    return map;
  }

  function matchTitleToHref(title, titleIndex) {
    if (!title) return null;
    const variants = [title, title.slice(0, 80), title.slice(0, 40), title.slice(0, 24)];
    for (const v of variants) {
      if (titleIndex.has(v)) return titleIndex.get(v);
    }
    const needle = title.slice(0, 28).toLowerCase();
    for (const [label, href] of titleIndex.entries()) {
      if (label.length < 12) continue;
      if (
        label.toLowerCase().startsWith(needle) ||
        title.toLowerCase().startsWith(label.slice(0, 28).toLowerCase())
      ) {
        return href;
      }
    }
    return null;
  }

  function collectFromSessionsTable(doc, extras = {}) {
    const table = findSessionsTable(doc);
    const scope = table || doc.querySelector("main") || doc.body;
    if (!scope) return [];

    const titleIndex = buildTitleIndex(doc);
    const store = createThreadStore();
    const harvestByTitle = extras.harvestByTitle || null;

    // Sidebar / other page links help title→url matching (never use the path as title)
    doc.querySelectorAll('a[href^="/search/"]').forEach((a) => {
      const url = absoluteSearchUrl(a.getAttribute("href"));
      if (!url) return;
      const title = cleanText(
        a.getAttribute("aria-label") || a.innerText || a.textContent
      );
      if (!title || title.startsWith("/search/")) return;
      store.upsert({ url, title, date: null });
    });

    findSessionRows(scope).forEach((row) => {
      const title = rowTitle(row);
      const date = row.querySelector("time")?.getAttribute("datetime") || null;
      const link = row.querySelector('a[href^="/search/"]');
      let url = link ? absoluteSearchUrl(link.getAttribute("href")) : null;
      if (!url) url = walkFiberForUrl(row);
      if (!url) {
        // One title cell is enough — avoid walking dozens of descendants per row
        const titleCell = row.querySelector('[role="cell"]:nth-child(2)') || row;
        if (titleCell !== row) url = walkFiberForUrl(titleCell);
      }
      if (!url) url = matchTitleToHref(title, titleIndex);
      if (!url && title && harvestByTitle) {
        url = harvestByTitle.get(normalizeTitleKey(title)) || null;
      }
      store.upsert({ url, title, date, row });
    });

    return store.values();
  }

  async function discoverUrlByOpeningRow(row) {
    if (!row) return null;
    const before = location.href;
    let captured = null;

    const capture = (url) => {
      try {
        const abs = new URL(String(url), location.origin);
        if (abs.pathname.startsWith("/search/")) {
          captured = abs.pathname + abs.search;
        }
      } catch {
        // ignore
      }
    };

    const origPush = history.pushState;
    const origReplace = history.replaceState;
    history.pushState = function (state, title, url) {
      if (url) capture(url);
      return origPush.apply(this, arguments);
    };
    history.replaceState = function (state, title, url) {
      if (url) capture(url);
      return origReplace.apply(this, arguments);
    };

    try {
      row.click();
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        if (captured) break;
        if (/\/search\//.test(location.pathname)) {
          captured = location.pathname + location.search;
          break;
        }
        await sleep(100);
      }

      if (captured || /\/search\//.test(location.pathname)) {
        if (!captured) captured = location.pathname + location.search;
        if (!isBulkListPage()) {
          history.back();
          const backDeadline = Date.now() + 8000;
          while (Date.now() < backDeadline) {
            if (isBulkListPage() || location.href === before) break;
            await sleep(150);
          }
          await sleep(300);
        }
        return captured;
      }

      if (location.href !== before && !isBulkListPage()) {
        history.back();
        await sleep(400);
      }
      return null;
    } finally {
      history.pushState = origPush;
      history.replaceState = origReplace;
    }
  }

  async function resolveMissingThreadUrls(threads, onProgress = () => {}) {
    const resolved = [];
    for (let i = 0; i < threads.length; i += 1) {
      const thread = threads[i];
      if (thread.url) {
        resolved.push({ ...thread, row: undefined });
        continue;
      }
      onProgress({ index: i, total: threads.length, title: thread.title });
      const table = findSessionsTable(document);
      let liveRow = null;
      if (table && thread.title) {
        const needle = thread.title.slice(0, 40);
        liveRow = findSessionRows(table).find((row) => {
          const t = rowTitle(row);
          return (
            t &&
            (t.startsWith(needle) || thread.title.startsWith(t.slice(0, 40)))
          );
        });
      }
      liveRow = liveRow || thread.row || null;
      liveRow?.scrollIntoView?.({ block: "center" });
      await sleep(200);
      // Re-try fiber after scroll into view (hydration)
      let url = liveRow ? walkFiberForUrl(liveRow) : null;
      if (!url) url = await discoverUrlByOpeningRow(liveRow);
      resolved.push({ ...thread, url: url || null, row: undefined });
      await sleep(250);
    }
    return resolved;
  }

  async function loadAllSessionRows(doc = document, onProgress = () => {}) {
    const table = findSessionsTable(doc);
    if (!table) return collectFromSessionsTable(doc);

    const isLibrary = isLibraryPage(doc);
    const maxSteps = isLibrary ? 400 : 120;
    const stepDelay = isLibrary ? 450 : 320;
    const idleNeeded = isLibrary ? 10 : 6;
    const bottomPause = isLibrary ? 700 : 350;
    const maxMs = isLibrary ? 90_000 : 45_000;
    const startedAt = Date.now();

    const harvester = installNetworkHarvester();
    try {
      await harvester.ready;
    } catch {
      // harvest is optional
    }

    const candidates = findListScrollers(table, doc);
    if (!candidates.length) {
      return collectFromSessionsTable(doc, {
        harvestByTitle: harvester.byTitle,
      });
    }

    const startTops = new Map(candidates.map((el) => [el, el.scrollTop]));
    const store = createThreadStore();

    const merge = () => {
      collectFromSessionsTable(doc, {
        harvestByTitle: harvester.byTitle,
      }).forEach((t) => store.upsert(t));
    };

    const pickScroller = () => {
      let best = candidates[0];
      let bestRoom = -1;
      for (const el of candidates) {
        const room = (el.scrollHeight || 0) - (el.clientHeight || 0);
        if (room > bestRoom) {
          bestRoom = room;
          best = el;
        }
      }
      return best;
    };

    const isReallyAtBottom = (el) => {
      if (!el) return false;
      const room = el.scrollHeight - el.clientHeight;
      if (room < 40) return false;
      return el.scrollTop + el.clientHeight >= el.scrollHeight - 32;
    };

    const bumpScroll = (scrollEl) => {
      const scope = findSessionsTable(doc) || table;
      const rows = findSessionRows(scope);
      const last = rows[rows.length - 1];
      if (last) {
        try {
          last.scrollIntoView({ block: "end", inline: "nearest" });
        } catch {
          // ignore
        }
      }
      if (!scrollEl) return;
      const before = scrollEl.scrollTop;
      const delta = Math.max(Math.floor(scrollEl.clientHeight * 0.9), 500);
      scrollEl.scrollTop = Math.min(before + delta, scrollEl.scrollHeight);
      if (scrollEl.scrollTop === before) {
        scrollEl.scrollTop = scrollEl.scrollHeight;
      }
      for (const el of candidates) {
        if (el === scrollEl) continue;
        el.scrollTop = Math.min(
          el.scrollTop + Math.max(el.clientHeight * 0.6, 300),
          el.scrollHeight
        );
      }
    };

    try {
      for (const el of candidates) el.scrollTop = 0;
      await sleep(350);
      merge();

      let peakCount = store.values().length;
      let idleAtPeak = 0;

      for (let i = 0; i < maxSteps; i += 1) {
        if (Date.now() - startedAt > maxMs) break;

        const scrollEl = pickScroller();
        const values = store.values();
        const withUrl = values.filter((t) => t.url).length;
        onProgress({
          rows: values.length,
          withUrl,
          step: i,
          peak: peakCount,
          phase: idleAtPeak > 2 ? "waiting" : "scrolling",
          idle: idleAtPeak,
          idleNeeded,
        });

        bumpScroll(scrollEl);
        await sleep(stepDelay);
        await new Promise((r) => requestAnimationFrame(() => r()));
        merge();

        const count = store.values().length;
        if (count > peakCount) {
          peakCount = count;
          idleAtPeak = 0;
        } else {
          idleAtPeak += 1;
        }

        if (isReallyAtBottom(scrollEl)) {
          await sleep(bottomPause);
          merge();
          if (store.values().length > peakCount) {
            peakCount = store.values().length;
            idleAtPeak = 0;
            continue;
          }
        }

        if (idleAtPeak >= idleNeeded) break;
      }

      // Only keep harvested entries that have a real title — bare UUID spray
      // produced blank "—" rows in the bulk list.
      for (const [url, title] of harvester.titleByUrl) {
        store.upsert({ url, title, date: null });
      }

      for (const [el, top] of startTops) {
        try {
          el.scrollTop = top;
        } catch {
          // ignore
        }
      }
      return store.values();
    } finally {
      harvester.stop();
    }
  }

  async function listProjectThreads(options = {}) {
    const doc = options.document || document;
    if (!isBulkListPage(doc)) {
      throw new Error(
        "Open a project (/projects/…) or your Library (/library) to bulk export."
      );
    }
    const project = getBulkSourceInfo(doc);
    let threads = await loadAllSessionRows(doc, options.onProgress);

    if (options.resolveMissing) {
      const missingCount = threads.filter((t) => !t.url).length;
      if (missingCount) {
        threads = await resolveMissingThreadUrls(threads, options.onResolveProgress);
      }
    }

    // Strip non-serializable row refs before messaging
    threads = threads.map(({ row, ...rest }) => rest);
    const withUrl = threads.filter((t) => t.url);
    const missing = threads.filter((t) => !t.url);
    return { project, threads: withUrl, missing };
  }

  api.isProjectPage = isProjectPage;
  api.isLibraryPage = isLibraryPage;
  api.isBulkListPage = isBulkListPage;
  api.getProjectInfo = getProjectInfo;
  api.getBulkSourceInfo = getBulkSourceInfo;
  api.listProjectThreads = listProjectThreads;
  api.collectFromSessionsTable = collectFromSessionsTable;
  api.resolveMissingThreadUrls = resolveMissingThreadUrls;
})();
