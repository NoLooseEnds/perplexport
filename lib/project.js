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
    return { slug, name, path };
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
    const fiberKey = Object.keys(startEl).find(
      (k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$")
    );
    if (!fiberKey) return null;

    let fiber = startEl[fiberKey];
    for (let depth = 0; depth < 50 && fiber; depth += 1, fiber = fiber.return) {
      const bags = [fiber.memoizedProps, fiber.pendingProps, fiber.memoizedState];
      for (const bag of bags) {
        const found = digForSearchUrl(bag, 0);
        if (found) return found;
      }
    }
    return null;
  }

  function digForSearchUrl(value, depth) {
    if (depth > 6 || value == null) return null;
    if (typeof value === "string") {
      if (value.includes("/search/")) return absoluteSearchUrl(value);
      if (/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)) {
        return `/search/${value}`;
      }
      return null;
    }
    if (typeof value !== "object") return null;
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 30)) {
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
      "backend_uuid",
      "context_uuid",
    ];
    for (const key of preferredKeys) {
      if (key in value) {
        const found = digForSearchUrl(value[key], depth + 1);
        if (found) return found;
      }
    }

    for (const key of Object.keys(value).slice(0, 40)) {
      if (typeof value[key] === "function") continue;
      const found = digForSearchUrl(value[key], depth + 1);
      if (found) return found;
    }
    return null;
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

  function collectFromSessionsTable(doc) {
    const table = findSessionsTable(doc);
    const scope = table || doc.querySelector("main") || doc.body;
    if (!scope) return [];

    const titleIndex = buildTitleIndex(doc);
    const seen = new Set();
    const threads = [];

    const add = (item) => {
      if (!item?.url && !item?.title) return;
      const key = item.url || `title:${(item.title || "").slice(0, 80)}`;
      if (seen.has(key)) return;
      seen.add(key);
      threads.push(item);
    };

    scope.querySelectorAll('a[href^="/search/"]').forEach((a) => {
      const url = absoluteSearchUrl(a.getAttribute("href"));
      if (!url) return;
      add({
        url,
        title: cleanText(a.getAttribute("aria-label") || a.innerText) || url,
        date: null,
      });
    });

    findSessionRows(scope).forEach((row) => {
      const title = rowTitle(row);
      const date = row.querySelector("time")?.getAttribute("datetime") || null;
      const link = row.querySelector('a[href^="/search/"]');
      let url = link ? absoluteSearchUrl(link.getAttribute("href")) : null;
      if (!url) {
        url =
          walkFiberForUrl(row) ||
          Array.from(row.querySelectorAll("*"))
            .slice(0, 40)
            .map((el) => walkFiberForUrl(el))
            .find(Boolean) ||
          null;
      }
      if (!url) url = matchTitleToHref(title, titleIndex);
      add({ url, title, date, row });
    });

    return threads;
  }

  async function discoverUrlByOpeningRow(row) {
    if (!row) return null;
    const before = location.href;
    row.click();
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (/\/search\//.test(location.pathname)) {
        const url = location.pathname + location.search;
        history.back();
        const backDeadline = Date.now() + 8000;
        while (Date.now() < backDeadline) {
          if (isProjectPage() || location.href === before) break;
          await sleep(150);
        }
        await sleep(300);
        return url;
      }
      await sleep(150);
    }
    if (location.href !== before && !isProjectPage()) {
      history.back();
      await sleep(400);
    }
    return null;
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
      const url = await discoverUrlByOpeningRow(liveRow);
      resolved.push({ ...thread, url: url || null, row: undefined });
      await sleep(250);
    }
    return resolved;
  }

  async function loadAllSessionRows(doc = document, onProgress = () => {}) {
    const table = findSessionsTable(doc);
    if (!table) return collectFromSessionsTable(doc);

    const candidates = [];
    const primary = findScrollParent(table);
    if (primary) candidates.push(primary);
    const main = doc.querySelector("main");
    if (main && isScrollable(main) && !candidates.includes(main)) {
      candidates.push(main);
    }
    // Walk up for any other scrollable ancestors (virtualized tables often nest)
    let node = table.parentElement;
    while (node && node !== doc.documentElement) {
      if (isScrollable(node) && !candidates.includes(node)) candidates.push(node);
      node = node.parentElement;
    }

    const scrollEl = candidates[0] || document.scrollingElement;
    const startTops = new Map(
      candidates.map((el) => [el, el.scrollTop])
    );
    const seen = new Map();

    const merge = () => {
      collectFromSessionsTable(doc).forEach((t) => {
        const key = t.url || `title:${(t.title || "").slice(0, 80)}`;
        const prev = seen.get(key);
        if (!prev) seen.set(key, t);
        else if (!prev.url && t.url) seen.set(key, { ...t, row: t.row || prev.row });
        else if (t.row) seen.set(key, { ...prev, row: t.row });
      });
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

    for (const el of candidates) el.scrollTop = 0;
    await sleep(250);
    merge();

    let stable = 0;
    let lastCount = seen.size;
    for (let i = 0; i < 100; i += 1) {
      onProgress({ rows: seen.size, step: i });
      bumpScroll();
      await sleep(350);
      merge();

      if (seen.size === lastCount) stable += 1;
      else {
        stable = 0;
        lastCount = seen.size;
      }

      const atBottom = candidates.every(
        (el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 12
      );
      // Keep going until we've had several empty growth cycles at the bottom
      if (atBottom && stable >= 5) break;
      if (!atBottom && stable >= 8) break;
    }

    for (const el of candidates) el.scrollTop = 0;
    await sleep(200);
    merge();
    for (const [el, top] of startTops) {
      try {
        el.scrollTop = top;
      } catch {
        // ignore
      }
    }
    if (scrollEl && startTops.has(scrollEl)) {
      // already restored
    }
    return Array.from(seen.values());
  }

  async function listProjectThreads(options = {}) {
    const doc = options.document || document;
    if (!isProjectPage(doc)) {
      throw new Error("This is not a project page (/projects/…).");
    }
    const project = getProjectInfo(doc);
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
  api.getProjectInfo = getProjectInfo;
  api.listProjectThreads = listProjectThreads;
  api.collectFromSessionsTable = collectFromSessionsTable;
  api.resolveMissingThreadUrls = resolveMissingThreadUrls;
})();
