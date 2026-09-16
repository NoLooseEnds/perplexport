(() => {
  if (window.__pplxExportFetchHooked) return;
  window.__pplxExportFetchHooked = true;

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
    "frontend_context_uuid",
    "frontendContextUuid",
    "slug_uuid",
  ]);

  const post = (payload, extra = {}) => {
    try {
      window.postMessage(
        {
          type: "__pplxExportHarvest",
          token: window.__pplxExportHarvestToken || null,
          payload,
          ...extra,
        },
        "*"
      );
    } catch {
      // ignore
    }
  };

  const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();

  const extractPairs = (data, depth = 0) => {
    if (depth > 10 || data == null) return;
    if (Array.isArray(data)) {
      data.slice(0, 400).forEach((item) => extractPairs(item, depth + 1));
      return;
    }
    if (typeof data !== "object") return;

    const title = clean(
      data.title ||
        data.name ||
        data.query ||
        data.first_query ||
        data.thread_title ||
        data.display_title ||
        data.thread_name ||
        ""
    );
    const idCandidates = [
      data.uuid,
      data.entry_uuid,
      data.entryUuid,
      data.context_uuid,
      data.contextUuid,
      data.backend_uuid,
      data.backendUuid,
      data.thread_id,
      data.threadId,
      data.frontend_context_uuid,
      data.frontendContextUuid,
      data.slug,
      data.permalink,
      data.url,
      data.href,
    ];
    if (title) {
      for (const id of idCandidates) {
        if (typeof id !== "string") continue;
        if (id.includes("/search/")) {
          post(null, { kind: "pair", title, url: id });
          break;
        }
        if (UUID_RE.test(id)) {
          post(null, { kind: "pair", title, url: `/search/${id}` });
          break;
        }
      }
    }

    for (const key of Object.keys(data).slice(0, 100)) {
      extractPairs(data[key], depth + 1);
    }
  };

  const sniff = async (res, reqUrl) => {
    try {
      const ct = res.headers.get("content-type") || "";
      const url = String(reqUrl || "");
      if (
        !/json|text|javascript/i.test(ct) &&
        !/api|graphql|session|thread|library|history|list|collection/i.test(url)
      ) {
        return;
      }
      const text = await res.clone().text();
      if (!text || text.length > 5_000_000) return;
      try {
        const json = JSON.parse(text);
        extractPairs(json);
        post(json);
      } catch {
        const ids = text.match(/\/search\/[a-f0-9-]{36}/gi);
        if (ids) post(ids);
      }
    } catch {
      // ignore
    }
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
        if (
          this.responseType &&
          this.responseType !== "" &&
          this.responseType !== "text" &&
          this.responseType !== "json"
        ) {
          return;
        }
        const text = this.responseText;
        if (!text) return;
        try {
          const json = JSON.parse(text);
          extractPairs(json);
          post(json);
        } catch {
          const ids = text.match(/\/search\/[a-f0-9-]{36}/gi);
          if (ids) post(ids);
        }
      } catch {
        // ignore
      }
    });
    return origSend.apply(this, args);
  };
})();
