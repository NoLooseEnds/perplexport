(() => {
  if (window.__pplxExportFetchHooked) return;
  window.__pplxExportFetchHooked = true;

  const post = (payload, extra = {}) => {
    try {
      window.postMessage(
        { type: "__pplxExportHarvest", payload, ...extra },
        "*"
      );
    } catch {
      // ignore
    }
  };

  const sniff = async (res, reqUrl) => {
    try {
      const ct = res.headers.get("content-type") || "";
      const url = String(reqUrl || "");
      if (
        !/json|text|javascript/i.test(ct) &&
        !/api|graphql|session|thread|library|history|list/i.test(url)
      ) {
        return;
      }
      const text = await res.clone().text();
      if (!text || text.length > 5_000_000) return;
      try {
        post(JSON.parse(text));
      } catch {
        const ids = text.match(/\/search\/[a-f0-9-]{36}/gi);
        if (ids) post(ids);
        const uuids = text.match(
          /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi
        );
        if (uuids) post(uuids.map((u) => `/search/${u}`));
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
          post(JSON.parse(text));
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
