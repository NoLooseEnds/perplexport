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

  const MODEL_HINT_RE =
    /\b(Claude|GPT-?[45o]|Gemini|Sonar|Grok|Mistral|Sonnet|Opus|Haiku|DeepSeek|o[13]|Perplexity|Auto)\b/i;

  const MODEL_ID_LABELS = {
    turbo: "Auto",
    experimental: "Experimental",
    pplx_pro: "Perplexity Pro",
    pplx_pro_upgraded: "Perplexity Pro",
    pplx_alpha: "Perplexity",
    sonar: "Sonar",
    sonar_pro: "Sonar Pro",
    claude46sonnet: "Claude Sonnet 4.6",
    claude45sonnet: "Claude Sonnet 4.5",
    claude40sonnet: "Claude Sonnet 4",
    claude4sonnet: "Claude Sonnet 4",
    claude37sonnet: "Claude Sonnet 3.7",
    claude35sonnet: "Claude Sonnet 3.5",
    claude40opus: "Claude Opus 4",
    claude41opus: "Claude Opus 4.1",
    claude4opus: "Claude Opus 4",
    gpt41: "GPT-4.1",
    "gpt-4.1": "GPT-4.1",
    gpt4o: "GPT-4o",
    "gpt-4o": "GPT-4o",
    gpt5: "GPT-5",
    "gpt-5": "GPT-5",
    o3: "o3",
    o3pro: "o3-pro",
    o1: "o1",
    gemini2flash: "Gemini 2.0 Flash",
    gemini25pro: "Gemini 2.5 Pro",
    grok4: "Grok 4",
  };

  function humanizeModelId(id) {
    if (!id || typeof id !== "string") return null;
    const key = id.trim();
    if (!key) return null;
    if (MODEL_ID_LABELS[key]) return MODEL_ID_LABELS[key];
    const lower = key.toLowerCase();
    if (MODEL_ID_LABELS[lower]) return MODEL_ID_LABELS[lower];
    if (/\s/.test(key) && MODEL_HINT_RE.test(key)) return cleanText(key);
    return key
      .replace(/_/g, " ")
      .replace(/([a-z])(\d)/gi, "$1 $2")
      .replace(/\bclaude\b/gi, "Claude")
      .replace(/\bsonnet\b/gi, "Sonnet")
      .replace(/\bopus\b/gi, "Opus")
      .replace(/\bhaiku\b/gi, "Haiku")
      .replace(/\bgpt\b/gi, "GPT")
      .replace(/\bgemini\b/gi, "Gemini")
      .replace(/\bsonar\b/gi, "Sonar")
      .replace(/\bgrok\b/gi, "Grok")
      .replace(/\bpplx\b/gi, "Perplexity")
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .replace(/\bGpt\b/g, "GPT")
      .replace(/\bO (\d)/g, "o$1");
  }

  function packModelInfo({ selected, display, label } = {}) {
    const sel =
      selected && typeof selected === "string" ? selected.trim() : null;
    const disp =
      display && typeof display === "string" ? display.trim() : null;
    let lab = label ? cleanText(label) : null;
    if (lab && /^(model|auto)$/i.test(lab)) lab = null;
    if (!lab) lab = humanizeModelId(sel) || humanizeModelId(disp);
    if (!lab && !sel && !disp) return null;
    const info = { label: lab || sel || disp };
    if (sel) info.selected = sel;
    if (disp) info.display = disp;
    return info;
  }

  function modelScore(model) {
    if (!model) return 0;
    return (
      (model.selected ? 2 : 0) + (model.display ? 1 : 0) + (model.label ? 1 : 0)
    );
  }

  function digModelFields(value, depth = 0) {
    if (depth > 6 || value == null) return null;
    if (typeof value !== "object") return null;
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 30)) {
        const found = digModelFields(item, depth + 1);
        if (found) return found;
      }
      return null;
    }

    const selected =
      value.user_selected_model ||
      value.userSelectedModel ||
      value.model_preference ||
      value.selected_model ||
      value.selectedModel ||
      null;
    const display =
      value.display_model || value.displayModel || null;
    if (
      (typeof selected === "string" && selected) ||
      (typeof display === "string" && display)
    ) {
      return packModelInfo({ selected, display });
    }

    const preferred = [
      "entry",
      "result",
      "search_result",
      "thread_entry",
      "message",
      "data",
    ];
    for (const key of preferred) {
      if (value[key] && typeof value[key] === "object") {
        const found = digModelFields(value[key], depth + 1);
        if (found) return found;
      }
    }
    return null;
  }

  function getModelFromFiber(startEl) {
    if (!startEl) return null;
    const propsKey = Object.keys(startEl).find((k) =>
      k.startsWith("__reactProps$")
    );
    if (propsKey) {
      const found = digModelFields(startEl[propsKey], 0);
      if (found) return found;
    }
    const fiberKey = Object.keys(startEl).find(
      (k) =>
        k.startsWith("__reactFiber$") ||
        k.startsWith("__reactInternalInstance$")
    );
    if (!fiberKey) return null;
    let fiber = startEl[fiberKey];
    for (let depth = 0; depth < 35 && fiber; depth += 1, fiber = fiber.return) {
      for (const bag of [fiber.memoizedProps, fiber.pendingProps]) {
        const found = digModelFields(bag, 0);
        if (found) return found;
      }
    }
    return null;
  }

  function getModelFromDomNear(el) {
    if (!el) return null;
    const scope =
      el.closest(".flex.flex-col") ||
      el.closest('[class*="group"]') ||
      el.parentElement;
    if (!scope) return null;

    const candidates = qsa(scope, "button, [role='button'], span, div").slice(
      0,
      100
    );
    for (const node of candidates) {
      if (node === el || el.contains(node)) continue;
      if (node.querySelector?.(".prose[data-renderer='lm']")) continue;
      if ((node.children?.length || 0) > 6) continue;
      const text = cleanText(node.innerText || node.textContent);
      if (!text || text.length > 56) continue;
      if (!MODEL_HINT_RE.test(text)) continue;
      if (
        /^(Copy|Share|Rewrite|Sources|Related|Export|Cite|Save|Edit)\b/i.test(
          text
        )
      ) {
        continue;
      }
      return packModelInfo({ label: text });
    }
    return null;
  }

  function getComposerModel(doc) {
    const root = getThreadRoot(doc);
    const buttons = qsa(
      root.parentElement || doc,
      "button, [role='button']"
    ).slice(0, 250);
    for (const btn of buttons) {
      const text = cleanText(btn.innerText || btn.textContent);
      if (!text || text.length > 40) continue;
      if (!MODEL_HINT_RE.test(text)) continue;
      if (/^(Ask|Search|Submit|Send)\b/i.test(text)) continue;
      // Prefer controls near the composer
      const nearInput = btn.closest("form") || btn.closest("[class*='Input']");
      if (!nearInput && text.toLowerCase() === "model") continue;
      if (/^(Model)$/i.test(text)) continue;
      return packModelInfo({ label: text });
    }
    return null;
  }

  function collectEntryModels(data) {
    const out = [];
    const seen = new Set();

    function walk(node, depth) {
      if (depth > 14 || node == null) return;
      if (Array.isArray(node)) {
        node.slice(0, 250).forEach((item) => walk(item, depth + 1));
        return;
      }
      if (typeof node !== "object") return;

      const selected =
        node.user_selected_model ||
        node.userSelectedModel ||
        node.model_preference ||
        node.selected_model ||
        null;
      const display = node.display_model || node.displayModel || null;
      if (
        (typeof selected === "string" && selected) ||
        (typeof display === "string" && display)
      ) {
        const query =
          (typeof node.query === "string" && node.query) ||
          (typeof node.query_str === "string" && node.query_str) ||
          (typeof node.user_query === "string" && node.user_query) ||
          (typeof node.prompt === "string" && node.prompt) ||
          null;
        const key = [
          selected || "",
          display || "",
          (query || "").slice(0, 48),
          node.uuid || node.entry_uuid || node.backend_uuid || out.length,
        ].join("|");
        if (!seen.has(key)) {
          seen.add(key);
          out.push({
            query: query ? cleanText(query) : null,
            selected: typeof selected === "string" ? selected : null,
            display: typeof display === "string" ? display : null,
          });
        }
      }

      const keys = Object.keys(node);
      for (let i = 0; i < Math.min(keys.length, 80); i += 1) {
        const v = node[keys[i]];
        if (v && typeof v === "object") walk(v, depth + 1);
      }
    }

    walk(data, 0);
    return out;
  }

  async function fetchThreadEntryModels() {
    try {
      const path = typeof location !== "undefined" ? location.pathname : "";
      const m = path.match(/\/(?:search|page)\/([^/?#]+)/);
      if (!m) return [];
      const res = await fetch(
        `${location.origin}/rest/thread/${encodeURIComponent(m[1])}`,
        {
          credentials: "include",
          headers: { Accept: "application/json" },
        }
      );
      if (!res.ok) return [];
      const data = await res.json();
      return collectEntryModels(data);
    } catch {
      return [];
    }
  }

  function matchEntryModel(query, index, entryModels) {
    if (!entryModels?.length) return null;
    if (query) {
      const q = query.slice(0, 80).toLowerCase();
      const hit = entryModels.find((e) => {
        if (!e.query) return false;
        const eq = e.query.slice(0, 80).toLowerCase();
        return (
          eq === q ||
          eq.startsWith(q.slice(0, 40)) ||
          q.startsWith(eq.slice(0, 40))
        );
      });
      if (hit) return packModelInfo(hit);
    }
    const withQuery = entryModels.filter((e) => e.query);
    const pool = withQuery.length ? withQuery : entryModels;
    if (pool[index]) return packModelInfo(pool[index]);
    return null;
  }

  function resolveTurnModel({
    answerEl,
    bubble,
    query,
    index,
    entryModels,
    fallback,
  }) {
    const fromApi = matchEntryModel(query, index, entryModels);
    const fromFiber = getModelFromFiber(answerEl || bubble);
    const fromDom = getModelFromDomNear(answerEl || bubble);
    if (fromApi) {
      if (!fromApi.label && fromDom?.label) {
        return { ...fromApi, label: fromDom.label };
      }
      return fromApi;
    }
    return fromFiber || fromDom || fallback || null;
  }

  function summarizeConversationModel(turns) {
    const models = turns.map((t) => t.model).filter(Boolean);
    if (!models.length) return null;
    const counts = new Map();
    for (const m of models) {
      const key = m.label || m.selected || m.display;
      if (!key) continue;
      const prev = counts.get(key) || { n: 0, model: m };
      prev.n += 1;
      if (modelScore(m) > modelScore(prev.model)) prev.model = m;
      counts.set(key, prev);
    }
    let best = null;
    for (const entry of counts.values()) {
      if (!best || entry.n > best.n || modelScore(entry.model) > modelScore(best.model)) {
        best = entry;
      }
    }
    if (!best) return null;
    const unique = [...counts.keys()];
    const info = { ...best.model };
    if (unique.length > 1) info.variants = unique;
    return info;
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

  function extractTurns(doc, entryModels = []) {
    const root = getThreadRoot(doc);
    const bubbles = findUserBubbles(root);
    const answers = qsa(root, '.prose[data-renderer="lm"]').filter((el) => {
      const text = cleanText(el.innerText || el.textContent);
      return text.length > 20;
    });
    const composerModel = getComposerModel(doc);

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
          model: resolveTurnModel({
            answerEl,
            bubble: null,
            query: null,
            index: i,
            entryModels,
            fallback: composerModel,
          }),
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
        model: resolveTurnModel({
          answerEl,
          bubble,
          query,
          index: i,
          entryModels,
          fallback: composerModel,
        }),
      });
    });

    answers.forEach((answerEl) => {
      if (usedAnswers.has(answerEl)) return;
      const packed = cloneAnswerForMarkdown(answerEl);
      const index = turns.length;
      turns.push({
        index: index + 1,
        query: null,
        timestamp: null,
        answerHtml: packed.html,
        answerText: cleanText(answerEl.innerText || answerEl.textContent),
        citations: packed.citations,
        model: resolveTurnModel({
          answerEl,
          bubble: null,
          query: null,
          index,
          entryModels,
          fallback: composerModel,
        }),
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
      if (richer) {
        const merged = { ...existing, ...turn };
        if (
          modelScore(existing.model) > modelScore(turn.model) &&
          !turn.model?.selected
        ) {
          merged.model = existing.model;
        }
        store.set(key, merged);
        continue;
      }
      const patch = { ...existing };
      let changed = false;
      if (!existing.timestamp && turn.timestamp) {
        patch.timestamp = turn.timestamp;
        changed = true;
      }
      if (modelScore(turn.model) > modelScore(existing.model)) {
        patch.model = turn.model;
        changed = true;
      }
      if (changed) store.set(key, patch);
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

  function getThreadSpace(doc) {
    const selectors = ['a[href^="/spaces/"]', 'a[href^="/projects/"]'];
    for (const sel of selectors) {
      const links = qsa(doc, sel);
      for (const a of links) {
        if (a.closest('[aria-hidden="true"]')) continue;
        const pill =
          qs(a, '[data-testid="task-collection-pill"]') ||
          qs(a, ".group\\/pill") ||
          a;
        const clone = pill.cloneNode(true);
        clone
          .querySelectorAll("svg, .font-emoji, img")
          .forEach((el) => el.remove());
        const name = cleanText(clone.innerText || clone.textContent);
        if (!name) continue;
        let href = a.getAttribute("href") || "";
        try {
          href = new URL(href, location.origin).href;
        } catch {
          // keep relative
        }
        return { name, url: href };
      }
    }
    return null;
  }

  const FILE_NAME_RE =
    /\.(?:jpe?g|png|gif|webp|svg|pdf|docx?|xlsx?|pptx?|csv|txt|zip|rar|7z|mp[34]|mov|webm|json|md|html?)$/i;

  function getThreadAttachments(doc) {
    const names = [];
    const seen = new Set();
    const add = (raw) => {
      const name = cleanText(raw);
      if (!name || /^\+\d+$/.test(name) || !FILE_NAME_RE.test(name)) return;
      const key = name.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      names.push(name);
    };

    qsa(
      doc,
      '[data-files-cell-measure-item] .group\\/asset, .group\\/asset, [class*="attachment"] a, [class*="Attachment"] a'
    ).forEach((el) => {
      if (el.closest('[aria-hidden="true"]')) return;
      if (el.closest('[data-testid="task-collection-pill"]')) return;
      const label =
        el.matches?.(".group\\/asset") || el.classList?.contains?.("group/asset")
          ? el.querySelector(".truncate") || el
          : el;
      const clone = label.cloneNode(true);
      clone.querySelectorAll("svg, img").forEach((n) => n.remove());
      add(clone.innerText || clone.textContent || el.getAttribute("download"));
    });

    // Filename-looking text in the first user bubble area
    const root = getThreadRoot(doc);
    qsa(root, "button, a, span, div").slice(0, 200).forEach((el) => {
      if (el.children.length > 3) return;
      const text = cleanText(el.innerText || el.textContent);
      if (text && text.length < 120 && FILE_NAME_RE.test(text) && !/\s{2,}/.test(text)) {
        add(text);
      }
    });

    return names;
  }

  function buildConversation(doc, turns, extras = {}) {
    const title = getThreadTitle(doc, turns);
    const threadDate = formatThreadDate(getThreadDate(turns));
    const space = getThreadSpace(doc);
    const attachments = [
      ...new Set([
        ...(getThreadAttachments(doc) || []),
        ...(extras.files || []),
      ]),
    ];
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

    const projectName = space?.name || extras.project || null;
    const projectUrl = space?.url || extras.projectUrl || null;
    const model =
      summarizeConversationModel(normalized) || extras.model || null;

    return {
      title,
      url,
      project: projectName,
      projectUrl,
      attachments,
      model,
      threadDate: threadDate?.iso || null,
      threadDateDisplay: threadDate?.display || null,
      threadDateRaw: threadDate?.raw || null,
      exportedAt: new Date().toISOString(),
      turnCount: normalized.length,
      turns: normalized,
      sources,
    };
  }

  async function extractConversation(doc = document, extras = {}) {
    const entryModels = await fetchThreadEntryModels();
    return buildConversation(doc, extractTurns(doc, entryModels), extras);
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
    const entryModelsPromise = fetchThreadEntryModels();

    await waitForThreadContent({
      document: doc,
      timeoutMs: options.readyTimeoutMs ?? 25000,
      onProgress: (info) => onProgress({ phase: "waiting", ...info }),
    });

    const entryModels = await entryModelsPromise;

    const snapshot = () => {
      mergeTurns(store, extractTurns(doc, entryModels));
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
    return buildConversation(doc, turns, {
      project: options.project || null,
      projectUrl: options.projectUrl || null,
      files: options.files || [],
    });
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
