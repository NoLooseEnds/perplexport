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
    if (!el || el === document.body || el === document.documentElement) return false;
    const style = window.getComputedStyle(el);
    if (!/(auto|scroll|overlay)/.test(style.overflowY)) return false;
    return el.scrollHeight > el.clientHeight + 40;
  }

  function findScrollParent(el) {
    let node = el;
    while (node && node !== document.documentElement) {
      if (isScrollable(node)) return node;
      node = node.parentElement;
    }
    return document.scrollingElement || document.documentElement;
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
    const urls = new Set();

    const onMessage = (event) => {
      if (event.source !== window) return;
      const msg = event.data;
      if (!msg || msg.type !== "__pplxExportHarvest") return;
      try {
        const payload = msg.payload;
        if (msg.kind === "pair" && msg.title && msg.url) {
          const url = absoluteSearchUrl(msg.url) || msg.url;
          if (url?.startsWith("/search/")) {
            urls.add(url);
            harvested.set(normalizeTitleKey(msg.title), url);
          }
          return;
        }
        const bucket = new Set();
        harvestSearchUrlsFromJson(payload, bucket);
        bucket.forEach((u) => urls.add(u));
        // Also try title/id pairs
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
            const url = `/search/${id}`;
            urls.add(url);
            harvested.set(normalizeTitleKey(title), url);
            break;
          }
        }
      }
      Object.keys(data)
        .slice(0, 80)
        .forEach((k) => walkPairs(data[k], depth + 1));
    }

    window.addEventListener("message", onMessage);

    const script = document.createElement("script");
    script.textContent = `(() => {
      if (window.__pplxExportFetchHooked) return;
      window.__pplxExportFetchHooked = true;
      const post = (payload, extra = {}) => {
        try {
          window.postMessage({ type: "__pplxExportHarvest", payload, ...extra }, "*");
        } catch (_) {}
      };
      const sniff = async (res, reqUrl) => {
        try {
          const ct = res.headers.get("content-type") || "";
          if (!/json|text|javascript/i.test(ct) && !/api|graphql|session|thread|library|history|list/i.test(String(reqUrl || ""))) {
            return;
          }
          const text = await res.clone().text();
          if (!text || text.length > 5000000) return;
          try { post(JSON.parse(text)); }
          catch (_) {
            const re = /\\/search\\/[a-f0-9-]{36}/gi;
            const ids = text.match(re);
            if (ids) post(ids);
            const uuidRe = /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi;
            const uuids = text.match(uuidRe);
            if (uuids) post(uuids.map((u) => "/search/" + u));
          }
        } catch (_) {}
      };
      const origFetch = window.fetch;
      window.fetch = async function (...args) {
        const res = await origFetch.apply(this, args);
        const reqUrl = typeof args[0] === "string" ? args[0] : args[0]?.url;
        sniff(res, reqUrl);
        return res;
      };
      const origOpen = XMLHttpRequest.prototype.open;
      const origSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        this.__pplxUrl = url;
        return origOpen.call(this, method, url, ...rest);
      };
      XMLHttpRequest.prototype.send = function (...args) {
        this.addEventListener("load", function () {
          try {
            if (this.responseType && this.responseType !== "" && this.responseType !== "text" && this.responseType !== "json") return;
            const text = this.responseText;
            if (!text) return;
            try { post(JSON.parse(text)); }
            catch (_) {
              const re = /\\/search\\/[a-f0-9-]{36}/gi;
              const ids = text.match(re);
              if (ids) post(ids);
            }
          } catch (_) {}
        });
        return origSend.apply(this, args);
      };
    })();`;
    (document.documentElement || document.head).appendChild(script);
    script.remove();

    return {
      urls,
      byTitle: harvested,
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

    // Sidebar / other page links help title→url matching
    doc.querySelectorAll('a[href^="/search/"]').forEach((a) => {
      const url = absoluteSearchUrl(a.getAttribute("href"));
      if (!url) return;
      const title =
        cleanText(a.getAttribute("aria-label") || a.innerText) || url;
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

    const maxSteps = isLibraryPage(doc) ? 300 : 120;
    const stepDelay = isLibraryPage(doc) ? 400 : 320;

    const harvester = installNetworkHarvester();

    const candidates = [];
    const primary = findScrollParent(table);
    if (primary) candidates.push(primary);
    const main = doc.querySelector("main");
    if (main && isScrollable(main) && !candidates.includes(main)) {
      candidates.push(main);
    }
    let node = table.parentElement;
    while (node && node !== doc.documentElement) {
      if (isScrollable(node) && !candidates.includes(node)) candidates.push(node);
      node = node.parentElement;
    }
    // Prefer the tallest scrollport — that's usually the infinite list
    candidates.sort((a, b) => b.scrollHeight - a.scrollHeight);

    const startTops = new Map(candidates.map((el) => [el, el.scrollTop]));
    const store = createThreadStore();

    const merge = () => {
      collectFromSessionsTable(doc, {
        harvestByTitle: harvester.byTitle,
      }).forEach((t) => store.upsert(t));
    };

    const scrollMetrics = () => {
      let maxHeight = 0;
      let maxTop = 0;
      for (const el of candidates) {
        maxHeight = Math.max(maxHeight, el.scrollHeight || 0);
        maxTop = Math.max(maxTop, el.scrollTop || 0);
      }
      return { maxHeight, maxTop };
    };

    const bumpScroll = () => {
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
      for (const el of candidates) {
        const delta = Math.max(Math.floor(el.clientHeight * 0.9), 480);
        el.scrollTop = Math.min(el.scrollTop + delta, el.scrollHeight);
      }
    };

    const atBottom = () =>
      candidates.length > 0 &&
      candidates.some(
        (el) =>
          el.scrollHeight > el.clientHeight + 40 &&
          el.scrollTop + el.clientHeight >= el.scrollHeight - 16
      ) &&
      candidates
        .filter((el) => el.scrollHeight > el.clientHeight + 40)
        .every(
          (el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 16
        );

    try {
      for (const el of candidates) el.scrollTop = 0;
      await sleep(300);
      merge();

      let stable = 0;
      let lastSig = "";
      for (let i = 0; i < maxSteps; i += 1) {
        const values = store.values();
        const withUrl = values.filter((t) => t.url).length;
        onProgress({
          rows: values.length,
          withUrl,
          step: i,
        });
        bumpScroll();
        await sleep(stepDelay);
        // Let the page paint / fetch the next page before scraping
        await new Promise((r) => requestAnimationFrame(() => r()));
        merge();

        const { maxHeight, maxTop } = scrollMetrics();
        const sig = `${values.length}|${Math.round(maxHeight)}|${Math.round(maxTop)}`;
        if (sig === lastSig) stable += 1;
        else {
          stable = 0;
          lastSig = sig;
        }

        // Stop only when we're at the bottom AND nothing new loaded for a while
        if (atBottom() && stable >= 6) break;
        // If scroll metrics and count froze mid-list, keep trying a bit longer
        if (!atBottom() && stable >= 14) break;
      }

      for (const el of candidates) el.scrollTop = 0;
      await sleep(200);
      merge();

      for (const url of harvester.urls) {
        store.upsert({
          url,
          title: null,
          date: null,
        });
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
