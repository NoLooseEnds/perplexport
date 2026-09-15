(() => {
  const ROOT = typeof globalThis !== "undefined" ? globalThis : window;
  const api = (ROOT.PplxExport = ROOT.PplxExport || {});

  function qs(root, selector) {
    try {
      return root.querySelector(selector);
    } catch {
      return null;
    }
  }

  function qsa(root, selector) {
    try {
      return Array.from(root.querySelectorAll(selector));
    } catch {
      return [];
    }
  }

  function cleanText(value) {
    return (value || "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function getThreadRoot(doc) {
    return (
      qs(doc, ".max-w-threadContentWidth") ||
      qs(doc, "main") ||
      doc.body
    );
  }

  function getQueryText(bubble) {
    const pre = qs(bubble, '[class*="whitespace-pre-line"]');
    if (pre) return cleanText(pre.innerText || pre.textContent);

    const select = qs(bubble, ".select-text");
    if (select) return cleanText(select.innerText || select.textContent);

    return cleanText(bubble.innerText || bubble.textContent);
  }

  function getTimestampNear(bubble) {
    const scope =
      bubble.closest(".flex.flex-col") ||
      bubble.parentElement ||
      bubble;
    const stamp = qsa(
      scope,
      "span.text-tertiary, span[class*='text-tertiary']"
    ).find((el) =>
      /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b|\d{1,2}:\d{2}/.test(
        el.textContent || ""
      )
    );
    return stamp ? cleanText(stamp.textContent) : null;
  }

  function collectCitations(answerEl) {
    const seen = new Map();
    qsa(answerEl, "[data-pplx-citation-url]").forEach((el) => {
      const url = el.getAttribute("data-pplx-citation-url");
      if (!url || seen.has(url)) return;
      const label =
        cleanText(el.getAttribute("aria-label") || el.textContent) ||
        (() => {
          try {
            return new URL(url).hostname.replace(/^www\./, "");
          } catch {
            return url;
          }
        })();
      seen.set(url, { index: seen.size + 1, url, label });
    });
    return Array.from(seen.values());
  }

  function cloneAnswerForMarkdown(answerEl) {
    const clone = answerEl.cloneNode(true);
    qsa(clone, "script, style, svg, button, [aria-hidden='true']").forEach(
      (el) => el.remove()
    );

    const citations = collectCitations(answerEl);
    const byUrl = new Map(citations.map((c) => [c.url, c]));

    qsa(clone, "[data-pplx-citation-url]").forEach((el) => {
      const url = el.getAttribute("data-pplx-citation-url");
      const cite = byUrl.get(url);
      const marker = document.createElement("span");
      marker.textContent = cite ? `[${cite.index}]` : "";
      el.replaceWith(marker);
    });

    qsa(clone, ".citation, .citation-nbsp, [class*='citation']").forEach(
      (el) => {
        if (!el.textContent.trim()) el.remove();
      }
    );

    return { html: clone.innerHTML, citations };
  }

  function findUserBubbles(root) {
    return qsa(root, '[class*="group/user-bubble"]').filter((el) => {
      const cls = typeof el.className === "string" ? el.className : "";
      return (
        cls.includes("group/user-bubble") &&
        !cls.includes("group-hover/user-bubble")
      );
    });
  }

  function turnKey(turn) {
    const q = (turn.query || "").slice(0, 240);
    if (q) return `q:${q}`;
    return `a:${(turn.answerText || "").slice(0, 240)}`;
  }

  function extractTurns(doc) {
    const root = getThreadRoot(doc);
    const bubbles = findUserBubbles(root);
    const answers = qsa(root, '.prose[data-renderer="lm"]').filter((el) => {
      const text = cleanText(el.innerText || el.textContent);
      return text.length > 20;
    });

    if (!bubbles.length && !answers.length) {
      const looseAnswers = qsa(doc, '.prose[data-renderer="lm"]');
      return looseAnswers.map((answerEl, i) => {
        const { html, citations } = cloneAnswerForMarkdown(answerEl);
        return {
          index: i + 1,
          query: null,
          timestamp: null,
          answerHtml: html,
          answerText: cleanText(answerEl.innerText || answerEl.textContent),
          citations,
        };
      });
    }

    const turns = [];
    const usedAnswers = new Set();

    bubbles.forEach((bubble, i) => {
      const query = getQueryText(bubble);
      const timestamp = getTimestampNear(bubble);

      let answerEl = null;
      for (const candidate of answers) {
        if (usedAnswers.has(candidate)) continue;
        if (
          !(
            bubble.compareDocumentPosition(candidate) &
            Node.DOCUMENT_POSITION_FOLLOWING
          )
        ) {
          continue;
        }
        const nextBubble = bubbles[i + 1];
        if (
          nextBubble &&
          nextBubble.compareDocumentPosition(candidate) &
            Node.DOCUMENT_POSITION_FOLLOWING
        ) {
          continue;
        }
        answerEl = candidate;
        break;
      }

      if (answerEl) usedAnswers.add(answerEl);

      const packed = answerEl
        ? cloneAnswerForMarkdown(answerEl)
        : { html: "", citations: [] };

      turns.push({
        index: i + 1,
        query,
        timestamp,
        answerHtml: packed.html,
        answerText: answerEl
          ? cleanText(answerEl.innerText || answerEl.textContent)
          : "",
        citations: packed.citations,
      });
    });

    answers.forEach((answerEl) => {
      if (usedAnswers.has(answerEl)) return;
      const packed = cloneAnswerForMarkdown(answerEl);
      turns.push({
        index: turns.length + 1,
        query: null,
        timestamp: null,
        answerHtml: packed.html,
        answerText: cleanText(answerEl.innerText || answerEl.textContent),
        citations: packed.citations,
      });
    });

    return turns;
  }

  function isScrollable(el) {
    if (!el || el === document.body || el === document.documentElement) {
      return false;
    }
    const style = window.getComputedStyle(el);
    const oy = style.overflowY;
    if (!/(auto|scroll|overlay)/.test(oy)) return false;
    return el.scrollHeight > el.clientHeight + 40;
  }

  function findScrollContainer(doc = document) {
    const thread = getThreadRoot(doc);
    let el = thread;
    while (el && el !== doc.documentElement) {
      if (isScrollable(el)) return el;
      el = el.parentElement;
    }

    const candidates = qsa(doc, "main, [class*='overflow'], [class*='Scroll']");
    let best = null;
    let bestScore = 0;
    for (const candidate of candidates) {
      if (!isScrollable(candidate)) continue;
      const score = candidate.scrollHeight - candidate.clientHeight;
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }

    return (
      best ||
      doc.scrollingElement ||
      doc.documentElement ||
      doc.body
    );
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function mergeTurns(store, incoming) {
    for (const turn of incoming) {
      const key = turnKey(turn);
      const existing = store.get(key);
      if (!existing) {
        store.set(key, turn);
        continue;
      }
      const richer =
        (turn.answerText || "").length > (existing.answerText || "").length ||
        (turn.citations?.length || 0) > (existing.citations?.length || 0);
      if (richer) store.set(key, { ...existing, ...turn });
      else if (!existing.timestamp && turn.timestamp) {
        store.set(key, { ...existing, timestamp: turn.timestamp });
      }
    }
  }

  function shortenTitle(text, maxWords = 8) {
    const words = cleanText(text).replace(/\s+/g, " ").split(" ").filter(Boolean);
    if (words.length <= maxWords) return words.join(" ");
    return `${words.slice(0, maxWords).join(" ")}…`;
  }

  function getThreadTitle(doc, turns) {
    const firstQuery = turns.find((t) => t.query)?.query;
    if (firstQuery) {
      return shortenTitle(firstQuery, 8);
    }

    const pageTitle = cleanText(doc.querySelector("title")?.textContent || "");
    const cleaned = pageTitle
      .replace(/\s*[·|–—-]\s*Perplexity.*$/i, "")
      .replace(/\.\.\.$/, "")
      .trim();
    return shortenTitle(cleaned || "Perplexity chat", 8);
  }

  function parseLooseDate(stamp) {
    if (!stamp) return null;
    const now = new Date();

    if (/\b(19|20)\d{2}\b/.test(stamp)) {
      const parsed = Date.parse(stamp);
      if (!Number.isNaN(parsed)) return new Date(parsed);
    }

    // "Sep 14, 11:47 AM" → inject current year (Date.parse without year is unreliable)
    const en = stamp.match(
      /^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{1,2}):(\d{2})\s*(AM|PM)?/i
    );
    if (en) {
      const months = {
        jan: 0,
        feb: 1,
        mar: 2,
        apr: 3,
        may: 4,
        jun: 5,
        jul: 6,
        aug: 7,
        sep: 8,
        oct: 9,
        nov: 10,
        dec: 11,
      };
      const mon = months[en[1].toLowerCase().slice(0, 3)];
      if (mon != null) {
        let year = now.getFullYear();
        let hours = Number(en[3]);
        const minutes = Number(en[4]);
        const ampm = en[5]?.toUpperCase();
        if (ampm === "PM" && hours < 12) hours += 12;
        if (ampm === "AM" && hours === 12) hours = 0;
        let d = new Date(year, mon, Number(en[2]), hours, minutes);
        if (d.getTime() - now.getTime() > 36 * 60 * 60 * 1000) {
          d = new Date(year - 1, mon, Number(en[2]), hours, minutes);
        }
        return d;
      }
    }

    // e.g. "14. sep. 2025, 11:47" / Norwegian-ish formats
    const m = stamp.match(
      /(\d{1,2})\.\s*([a-zA-ZæøåÆØÅ.]+)\.?\s*(\d{4})?(?:,?\s*(\d{1,2}:\d{2}))?/
    );
    if (m) {
      const months = {
        jan: 0,
        feb: 1,
        mar: 2,
        apr: 3,
        mai: 4,
        may: 4,
        jun: 5,
        jul: 6,
        aug: 7,
        sep: 8,
        okt: 9,
        oct: 9,
        nov: 10,
        des: 11,
        dec: 11,
      };
      const mon = months[m[2].toLowerCase().replace(".", "").slice(0, 3)];
      if (mon != null) {
        const year = m[3] ? Number(m[3]) : now.getFullYear();
        const [hh, mm] = (m[4] || "12:00").split(":").map(Number);
        let d = new Date(year, mon, Number(m[1]), hh, mm);
        if (!m[3] && d.getTime() - now.getTime() > 36 * 60 * 60 * 1000) {
          d = new Date(year - 1, mon, Number(m[1]), hh, mm);
        }
        return d;
      }
    }
    return null;
  }

  function getThreadDate(turns) {
    const dates = turns
      .map((t) => parseLooseDate(t.timestamp))
      .filter(Boolean)
      .sort((a, b) => a - b);
    return dates[0] || null;
  }

  function formatThreadDate(date) {
    if (!date) return null;
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    const dd = String(date.getDate()).padStart(2, "0");
    return {
      iso: `${yyyy}-${mm}-${dd}`,
      display: date.toLocaleString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }),
      raw: date.toISOString(),
    };
  }

  function buildConversation(doc, turns) {
    const title = getThreadTitle(doc, turns);
    const threadDate = formatThreadDate(getThreadDate(turns));
    const url =
      (typeof location !== "undefined" && location.href) ||
      doc.querySelector('link[rel="canonical"]')?.href ||
      "";

    const normalized = turns.map((turn, i) => ({
      ...turn,
      index: i + 1,
    }));

    const sources = [];
    const seen = new Set();
    normalized.forEach((turn) => {
      (turn.citations || []).forEach((c) => {
        if (seen.has(c.url)) return;
        seen.add(c.url);
        sources.push(c);
      });
    });

    return {
      title,
      url,
      threadDate: threadDate?.iso || null,
      threadDateDisplay: threadDate?.display || null,
      threadDateRaw: threadDate?.raw || null,
      exportedAt: new Date().toISOString(),
      turnCount: normalized.length,
      turns: normalized,
      sources,
    };
  }

  function extractConversation(doc = document) {
    return buildConversation(doc, extractTurns(doc));
  }

  /**
   * Wait until the thread DOM has at least one query or answer mounted.
   */
  async function waitForThreadContent(options = {}) {
    const doc = options.document || document;
    const timeoutMs = options.timeoutMs ?? 25000;
    const onProgress = options.onProgress || (() => {});
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      const root = getThreadRoot(doc);
      const bubbles = findUserBubbles(root).length;
      const answers = qsa(root, '.prose[data-renderer="lm"]').filter((el) => {
        const text = cleanText(el.innerText || el.textContent);
        return text.length > 20;
      }).length;

      onProgress({ bubbles, answers, elapsed: Date.now() - start });

      if (bubbles > 0 || answers > 0) {
        await sleep(450);
        const root2 = getThreadRoot(doc);
        const bubbles2 = findUserBubbles(root2).length;
        const answers2 = qsa(root2, '.prose[data-renderer="lm"]').filter(
          (el) => {
            const text = cleanText(el.innerText || el.textContent);
            return text.length > 20;
          }
        ).length;
        if (bubbles2 > 0 || answers2 > 0) return true;
      }
      await sleep(300);
    }

    throw new Error("Thread content did not appear in time.");
  }

  /**
   * Scroll through the thread so lazy/virtualized content mounts,
   * accumulate turns as they appear, then return a full conversation.
   */
  async function loadFullConversation(options = {}) {
    const doc = options.document || document;
    const onProgress = options.onProgress || (() => {});
    const scrollEl = findScrollContainer(doc);
    const store = new Map();
    const startTop = scrollEl.scrollTop;

    await waitForThreadContent({
      document: doc,
      timeoutMs: options.readyTimeoutMs ?? 25000,
      onProgress: (info) => onProgress({ phase: "waiting", ...info }),
    });

    const snapshot = () => {
      mergeTurns(store, extractTurns(doc));
      onProgress({
        phase: "loading",
        turns: store.size,
        scrollTop: scrollEl.scrollTop,
        scrollHeight: scrollEl.scrollHeight,
      });
    };

    scrollEl.scrollTop = 0;
    await sleep(250);
    snapshot();

    // Nudge upward in case older messages load above the fold
    for (let i = 0; i < 8; i++) {
      const prevHeight = scrollEl.scrollHeight;
      const prevCount = store.size;
      scrollEl.scrollTop = 0;
      await sleep(280);
      snapshot();
      if (scrollEl.scrollHeight <= prevHeight && store.size === prevCount) break;
    }

    let stable = 0;
    let lastSig = "";
    const maxSteps = 80;

    for (let step = 0; step < maxSteps; step++) {
      const beforeTop = scrollEl.scrollTop;
      const delta = Math.max(Math.floor(scrollEl.clientHeight * 0.75), 400);
      const nextTop = Math.min(
        beforeTop + delta,
        Math.max(scrollEl.scrollHeight - scrollEl.clientHeight, 0)
      );
      scrollEl.scrollTop = nextTop;
      await sleep(320);
      snapshot();

      const atBottom =
        scrollEl.scrollTop + scrollEl.clientHeight >=
        scrollEl.scrollHeight - 8;
      const sig = `${store.size}|${scrollEl.scrollHeight}|${Math.round(scrollEl.scrollTop)}`;
      if (sig === lastSig) stable += 1;
      else stable = 0;
      lastSig = sig;

      if (atBottom && stable >= 3) break;
      if (!atBottom && scrollEl.scrollTop === beforeTop && stable >= 4) break;
    }

    // Final pass at bottom and top to catch stragglers
    scrollEl.scrollTop = scrollEl.scrollHeight;
    await sleep(350);
    snapshot();
    scrollEl.scrollTop = 0;
    await sleep(250);
    snapshot();

    // Restore approximate position
    scrollEl.scrollTop = startTop;

    const turns = Array.from(store.values());
    onProgress({ phase: "done", turns: turns.length });
    return buildConversation(doc, turns);
  }

  function isThreadPage(doc = document) {
    const href =
      (typeof location !== "undefined" && location.pathname) || "";
    if (/\/search\//.test(href) || /\/page\//.test(href)) return true;
    const root = getThreadRoot(doc);
    return (
      findUserBubbles(root).length > 0 ||
      qsa(root, '.prose[data-renderer="lm"]').length > 0
    );
  }

  api.extractConversation = extractConversation;
  api.loadFullConversation = loadFullConversation;
  api.waitForThreadContent = waitForThreadContent;
  api.findScrollContainer = findScrollContainer;
  api.isThreadPage = isThreadPage;
  api.cleanText = cleanText;
})();
