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

  const UUID_RE =
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  const UUID_KEYS = new Set([
    "uuid",
    "thread_id",
    "threadId",
    "entry_uuid",
    "entryUuid",
    "backend_uuid",
    "backendUuid",
    "context_uuid",
    "contextUuid",
  ]);

  function digForSearchUrl(value, depth, parentKey = null) {
    if (depth > 5 || value == null) return null;
    if (typeof value === "string") {
      if (value.includes("/search/")) return absoluteSearchUrl(value);
      if (parentKey && UUID_KEYS.has(parentKey) && UUID_RE.test(value)) {
        return `/search/${value}`;
      }
      return null;
    }
    if (typeof value !== "object") return null;
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 25)) {
        const found = digForSearchUrl(item, depth + 1, parentKey);
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
      "entry",
      "session",
      "context",
      "thread",
      "item",
      "data",
    ];
    for (const key of preferredKeys) {
      if (key in value) {
        const found = digForSearchUrl(value[key], depth + 1, key);
        if (found) return found;
      }
    }

    // Shallow fallback only — avoid walking huge React trees every scroll tick
    if (depth >= 2) return null;
    for (const key of Object.keys(value).slice(0, 25)) {
      if (typeof value[key] === "function") continue;
      const found = digForSearchUrl(value[key], depth + 1, key);
      if (found) return found;
    }
    return null;
  }

  function normalizeTitleKey(title) {
    return cleanText(title || "")
      .toLowerCase()
      .slice(0, 80);
  }

  /** Merge threads by URL primarily; title only fills missing URLs (never collapses distinct URLs). */
  function createThreadStore() {
    const byUrl = new Map();
    const byTitle = new Map();

    const upsert = (item) => {
      if (!item?.url && !item?.title) return;
      const titleKey = normalizeTitleKey(item.title);

      if (item.url) {
        const existingByUrl = byUrl.get(item.url);
        const merged = {
          url: item.url,
          title: item.title || existingByUrl?.title || null,
          date: item.date || existingByUrl?.date || null,
          row: item.row || existingByUrl?.row || null,
        };

        // Absorb a title-only placeholder with the same title
        if (titleKey) {
          const titled = byTitle.get(titleKey);
          if (titled && !titled.url) {
            merged.title = merged.title || titled.title;
            merged.date = merged.date || titled.date;
            merged.row = merged.row || titled.row;
            byTitle.delete(titleKey);
          }
        }

        byUrl.set(item.url, merged);

        if (titleKey) {
          const titled = byTitle.get(titleKey);
          // Never overwrite a different URL that already owns this title key
          if (!titled || !titled.url || titled.url === item.url) {
            byTitle.set(titleKey, merged);
          }
        }
        return;
      }

      // Title-only row (missing link)
      if (!titleKey) return;
      const existingByTitle = byTitle.get(titleKey);
      if (existingByTitle?.url) {
        const merged = {
          url: existingByTitle.url,
          title: item.title || existingByTitle.title,
          date: item.date || existingByTitle.date,
          row: item.row || existingByTitle.row,
        };
        byUrl.set(merged.url, merged);
        byTitle.set(titleKey, merged);
        return;
      }

      byTitle.set(titleKey, {
        url: null,
        title: item.title,
        date: item.date || existingByTitle?.date || null,
        row: item.row || existingByTitle?.row || null,
      });
    };

    const values = () => {
      const out = new Map();
      for (const t of byUrl.values()) {
        out.set(t.url, t);
      }
      for (const t of byTitle.values()) {
        if (t.url && byUrl.has(t.url)) continue;
        out.set(`title:${normalizeTitleKey(t.title)}`, t);
      }
      return Array.from(out.values());
    };

    return { upsert, values };
  }

  function harvestSearchUrlsFromJson(data, into, depth = 0, parentKey = null) {
    if (depth > 10 || data == null) return;
    if (typeof data === "string") {
      if (data.includes("/search/")) {
        const url = absoluteSearchUrl(data);
        if (url) into.add(url);
      } else if (
        parentKey &&
        UUID_KEYS.has(parentKey) &&
        UUID_RE.test(data)
      ) {
        into.add(`/search/${data}`);
      }
      return;
    }
    if (typeof data !== "object") return;
    if (Array.isArray(data)) {
      data
        .slice(0, 200)
        .forEach((item) =>
          harvestSearchUrlsFromJson(item, into, depth + 1, parentKey)
        );
      return;
    }

    for (const key of Object.keys(data).slice(0, 80)) {
      harvestSearchUrlsFromJson(data[key], into, depth + 1, key);
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
    const token =
      (crypto.randomUUID && crypto.randomUUID()) ||
      `pplx-${Date.now()}-${Math.random().toString(16).slice(2)}`;

    const rememberPair = (rawTitle, rawUrl) => {
      const title = cleanText(rawTitle || "");
      const url = absoluteSearchUrl(rawUrl) || rawUrl;
      if (!title || !url?.startsWith("/search/")) return;
      urls.add(url);
      const key = normalizeTitleKey(title);
      if (!harvested.has(key)) harvested.set(key, url);
      if (!titleByUrl.has(url)) titleByUrl.set(url, title);
    };

    const onMessage = (event) => {
      if (event.source !== window) return;
      const msg = event.data;
      if (!msg || msg.type !== "__pplxExportHarvest") return;
      if (msg.token !== token) return;
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
      token,
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

  function buildTitleIndex(doc, scope = null) {
    const map = new Map();
    const root = scope || doc;
    root.querySelectorAll('a[href^="/search/"]').forEach((a) => {
      const href = absoluteSearchUrl(a.getAttribute("href"));
      if (!href) return;
      const label = cleanText(
        a.getAttribute("aria-label") || a.innerText || a.textContent
      );
      if (!label || label.startsWith("/search/")) return;
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

    // Prefer links inside the Sessions table; fall back to main (not whole-document sidebar)
    const titleIndex = buildTitleIndex(doc, scope);
    const store = createThreadStore();
    const harvestByTitle = extras.harvestByTitle || null;

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

  async function ensureBackOnListPage(listHref) {
    if (isBulkListPage()) return true;
    try {
      history.back();
    } catch {
      // ignore
    }
    const backDeadline = Date.now() + 8000;
    while (Date.now() < backDeadline) {
      if (isBulkListPage() || location.href === listHref) return true;
      await sleep(150);
    }
    try {
      location.assign(listHref);
    } catch {
      // ignore
    }
    const assignDeadline = Date.now() + 10000;
    while (Date.now() < assignDeadline) {
      if (isBulkListPage()) return true;
      await sleep(200);
    }
    return isBulkListPage();
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
          await ensureBackOnListPage(before);
          await sleep(300);
        }
        return captured;
      }

      if (location.href !== before && !isBulkListPage()) {
        await ensureBackOnListPage(before);
      }
      return null;
    } finally {
      history.pushState = origPush;
      history.replaceState = origReplace;
    }
  }

  async function findLiveRowByTitle(title) {
    if (!title) return null;
    const table = findSessionsTable(document);
    if (!table) return null;
    const needle = title.slice(0, 40);
    const match = () =>
      findSessionRows(table).find((row) => {
        const t = rowTitle(row);
        return (
          t &&
          (t.startsWith(needle) || title.startsWith(t.slice(0, 40)))
        );
      });

    let liveRow = match();
    if (liveRow) return liveRow;

    // Virtualized lists: scroll a bit and retry
    const scrollers = findListScrollers(table, document);
    for (const el of scrollers.slice(0, 2)) {
      const start = el.scrollTop;
      for (let i = 0; i < 6; i += 1) {
        el.scrollTop = Math.min(
          el.scrollTop + Math.max(el.clientHeight * 0.8, 400),
          el.scrollHeight
        );
        await sleep(200);
        liveRow = match();
        if (liveRow) return liveRow;
      }
      el.scrollTop = start;
    }
    return null;
  }

  async function resolveMissingThreadUrls(threads, onProgress = () => {}) {
    const resolved = [];
    const listHref = location.href;
    for (let i = 0; i < threads.length; i += 1) {
      const thread = threads[i];
      if (thread.url) {
        resolved.push({ ...thread, row: undefined });
        continue;
      }
      onProgress({ index: i, total: threads.length, title: thread.title });
      if (!isBulkListPage()) {
        await ensureBackOnListPage(listHref);
      }
      let liveRow = await findLiveRowByTitle(thread.title);
      liveRow?.scrollIntoView?.({ block: "center" });
      await sleep(200);
      // Re-try fiber after scroll into view (hydration)
      let url = liveRow ? walkFiberForUrl(liveRow) : null;
      if (!url) url = await discoverUrlByOpeningRow(liveRow);
      resolved.push({ ...thread, url: url || null, row: undefined });
      await sleep(250);
    }
    if (!isBulkListPage()) {
      await ensureBackOnListPage(listHref);
    }
    return resolved;
  }

  async function loadAllSessionRows(doc = document, onProgress = () => {}) {
    const table = findSessionsTable(doc);
    if (!table) return collectFromSessionsTable(doc);

    const isLibrary = isLibraryPage(doc);
    const maxSteps = isLibrary ? 1200 : 200;
    const stepDelay = isLibrary ? 380 : 280;
    const bottomIdleNeeded = isLibrary ? 14 : 8;
    const bottomPause = isLibrary ? 1100 : 500;
    const maxMs = isLibrary ? 8 * 60_000 : 90_000;
    const startedAt = Date.now();

    const harvester = installNetworkHarvester();
    try {
      await harvester.ready;
    } catch {
      // harvest is optional
    }

    let candidates = findListScrollers(table, doc);
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

    const refreshCandidates = () => {
      const next = findListScrollers(findSessionsTable(doc) || table, doc);
      if (next.length) candidates = next;
      return candidates;
    };

    const pickScroller = () => {
      refreshCandidates();
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
      return el.scrollTop + el.clientHeight >= el.scrollHeight - 48;
    };

    const fireScrollSignals = (scrollEl, deltaY) => {
      if (!scrollEl) return;
      try {
        scrollEl.dispatchEvent(
          new WheelEvent("wheel", {
            bubbles: true,
            cancelable: true,
            deltaY,
            deltaMode: 0,
          })
        );
      } catch {
        // ignore
      }
      try {
        scrollEl.dispatchEvent(new Event("scroll", { bubbles: true }));
      } catch {
        // ignore
      }
    };

    const bumpScroll = (scrollEl) => {
      if (!scrollEl) return;
      const before = scrollEl.scrollTop;
      const delta = Math.max(Math.floor(scrollEl.clientHeight * 0.75), 420);
      // Prefer wheel-like motion so IntersectionObservers / lazy loaders wake up
      fireScrollSignals(scrollEl, delta);
      scrollEl.scrollTop = Math.min(before + delta, scrollEl.scrollHeight);
      if (scrollEl.scrollTop === before) {
        scrollEl.scrollTop = scrollEl.scrollHeight;
        fireScrollSignals(scrollEl, delta);
      }
      for (const el of candidates) {
        if (el === scrollEl) continue;
        const d = Math.max(Math.floor(el.clientHeight * 0.5), 280);
        fireScrollSignals(el, d);
        el.scrollTop = Math.min(el.scrollTop + d, el.scrollHeight);
      }
      const scope = findSessionsTable(doc) || table;
      const rows = findSessionRows(scope);
      const last = rows[rows.length - 1];
      if (last) {
        try {
          last.scrollIntoView({ block: "nearest", inline: "nearest" });
        } catch {
          // ignore
        }
      }
    };

    try {
      for (const el of candidates) el.scrollTop = 0;
      await sleep(400);
      merge();

      let peakCount = store.values().length;
      let peakScrollHeight = 0;
      let bottomIdle = 0;

      for (let i = 0; i < maxSteps; i += 1) {
        if (Date.now() - startedAt > maxMs) break;

        const scrollEl = pickScroller();
        peakScrollHeight = Math.max(
          peakScrollHeight,
          scrollEl?.scrollHeight || 0
        );

        const values = store.values();
        const withUrl = values.filter((t) => t.url).length;
        const atBottom = isReallyAtBottom(scrollEl);
        onProgress({
          rows: values.length,
          withUrl,
          step: i,
          peak: peakCount,
          phase: atBottom ? "waiting" : "scrolling",
          idle: bottomIdle,
          idleNeeded: bottomIdleNeeded,
        });

        bumpScroll(scrollEl);
        await sleep(stepDelay);
        await new Promise((r) => requestAnimationFrame(() => r()));
        merge();

        const count = store.values().length;
        const height = scrollEl?.scrollHeight || 0;
        const grew =
          count > peakCount || height > peakScrollHeight + 20;

        if (count > peakCount) peakCount = count;
        if (height > peakScrollHeight) peakScrollHeight = height;

        if (grew) {
          bottomIdle = 0;
          continue;
        }

        // Mid-list flat stretches are normal (slow API / virtualization).
        // Only treat idle as "done" once we are actually at the bottom.
        if (!isReallyAtBottom(scrollEl)) {
          bottomIdle = 0;
          continue;
        }

        await sleep(bottomPause);
        merge();
        const afterCount = store.values().length;
        const afterHeight = scrollEl?.scrollHeight || 0;
        if (
          afterCount > peakCount ||
          afterHeight > peakScrollHeight + 20
        ) {
          peakCount = Math.max(peakCount, afterCount);
          peakScrollHeight = Math.max(peakScrollHeight, afterHeight);
          bottomIdle = 0;
          continue;
        }

        // Nudge again at bottom — some loaders only fire on overscroll/wheel
        fireScrollSignals(scrollEl, 800);
        scrollEl.scrollTop = scrollEl.scrollHeight;
        bottomIdle += 1;
        if (bottomIdle >= bottomIdleNeeded) break;
      }

      // Attach harvested URLs onto existing title-only rows only — do not inject
      // arbitrary API threads that never appeared in the Sessions table.
      const knownTitles = new Set(
        store
          .values()
          .map((t) => normalizeTitleKey(t.title))
          .filter(Boolean)
      );
      for (const [titleKey, url] of harvester.byTitle) {
        if (!knownTitles.has(titleKey)) continue;
        const title = harvester.titleByUrl.get(url) || null;
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
