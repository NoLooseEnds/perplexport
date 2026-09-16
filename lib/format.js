(() => {
  const ROOT = typeof globalThis !== "undefined" ? globalThis : window;
  const api = (ROOT.PplxExport = ROOT.PplxExport || {});

  function decodeEntities(text) {
    const el = document.createElement("textarea");
    el.innerHTML = text;
    return el.value;
  }

  function htmlToMarkdown(html) {
    if (!html) return "";

    const wrap = document.createElement("div");
    wrap.innerHTML = html;

    const walk = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        return node.nodeValue.replace(/\s+/g, " ");
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return "";

      const tag = node.tagName.toLowerCase();
      const children = Array.from(node.childNodes).map(walk).join("");

      switch (tag) {
        case "br":
          return "\n";
        case "strong":
        case "b":
          return children.trim() ? `**${children.trim()}**` : "";
        case "em":
        case "i":
          return children.trim() ? `*${children.trim()}*` : "";
        case "code":
          if (node.parentElement?.tagName?.toLowerCase() === "pre") {
            return children;
          }
          return children ? `\`${children}\`` : "";
        case "pre": {
          const code = cleanCode(node.textContent || "");
          return `\n\n\`\`\`\n${code}\n\`\`\`\n\n`;
        }
        case "a": {
          const href = node.getAttribute("href") || "";
          const label = children.trim() || href || "";
          if (!href || href.startsWith("#")) return label;
          const lower = href.trim().toLowerCase();
          if (
            lower.startsWith("javascript:") ||
            lower.startsWith("data:") ||
            lower.startsWith("vbscript:")
          ) {
            return label;
          }
          return `[${label}](${href})`;
        }
        case "h1":
          return `\n\n# ${children.trim()}\n\n`;
        case "h2":
          return `\n\n## ${children.trim()}\n\n`;
        case "h3":
          return `\n\n### ${children.trim()}\n\n`;
        case "h4":
          return `\n\n#### ${children.trim()}\n\n`;
        case "li": {
          const parent = node.parentElement?.tagName?.toLowerCase();
          const prefix = parent === "ol" ? "1. " : "- ";
          return `${prefix}${children.trim()}\n`;
        }
        case "ul":
        case "ol":
          return `\n${children}\n`;
        case "blockquote":
          return (
            "\n\n" +
            children
              .trim()
              .split("\n")
              .map((line) => `> ${line}`)
              .join("\n") +
            "\n\n"
          );
        case "p":
        case "div":
        case "section":
          return `\n\n${children.trim()}\n\n`;
        case "hr":
          return "\n\n---\n\n";
        case "table":
          return `\n\n${tableToMarkdown(node)}\n\n`;
        default:
          return children;
      }
    };

    let md = Array.from(wrap.childNodes).map(walk).join("");
    md = decodeEntities(md);
    md = md.replace(/[ \t]+\n/g, "\n");
    md = md.replace(/\n{3,}/g, "\n\n");
    return md.trim();
  }

  function cleanCode(text) {
    return text.replace(/^\n+|\n+$/g, "");
  }

  function tableToMarkdown(table) {
    const rows = Array.from(table.querySelectorAll("tr")).map((tr) =>
      Array.from(tr.querySelectorAll("th, td")).map((cell) =>
        (cell.textContent || "").trim().replace(/\|/g, "\\|")
      )
    );
    if (!rows.length) return "";
    const width = Math.max(...rows.map((r) => r.length));
    const norm = rows.map((r) => {
      const copy = r.slice();
      while (copy.length < width) copy.push("");
      return copy;
    });
    const header = norm[0];
    const sep = header.map(() => "---");
    const body = norm.slice(1);
    return [header, sep, ...body]
      .map((r) => `| ${r.join(" | ")} |`)
      .join("\n");
  }

  function slugify(title) {
    return (
      (title || "perplexity-chat")
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60) || "perplexity-chat"
    );
  }

  function yamlEscape(value) {
    const s = String(value ?? "");
    if (/[:#\[\]{}",'\n]/.test(s) || s.trim() !== s) {
      return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    }
    return s;
  }

  function safeMdUrl(url) {
    const href = String(url || "").trim();
    if (!href) return null;
    const lower = href.toLowerCase();
    if (
      lower.startsWith("javascript:") ||
      lower.startsWith("data:") ||
      lower.startsWith("vbscript:")
    ) {
      return null;
    }
    return href;
  }

  function toMarkdown(conversation) {
    const lines = [];
    lines.push("---");
    lines.push(`title: ${yamlEscape(conversation.title)}`);
    if (conversation.threadDate) {
      lines.push(`date: ${conversation.threadDate}`);
    }
    if (conversation.project) {
      lines.push(`project: ${yamlEscape(conversation.project)}`);
    }
    if (conversation.projectUrl) {
      lines.push(`project_url: ${yamlEscape(conversation.projectUrl)}`);
    }
    if (conversation.url) lines.push(`url: ${yamlEscape(conversation.url)}`);
    lines.push(`exported: ${conversation.exportedAt}`);
    lines.push(`turns: ${conversation.turnCount}`);
    lines.push("---");
    lines.push("");
    lines.push(`# ${conversation.title}`);
    lines.push("");

    const meta = [];
    if (conversation.threadDateDisplay || conversation.threadDate) {
      meta.push(
        `- **Date:** ${conversation.threadDateDisplay || conversation.threadDate}`
      );
    }
    if (conversation.project) {
      const projectUrl = safeMdUrl(conversation.projectUrl);
      meta.push(
        projectUrl
          ? `- **Project:** [${conversation.project}](${projectUrl})`
          : `- **Project:** ${conversation.project}`
      );
    }
    if (conversation.url) meta.push(`- **URL:** ${conversation.url}`);
    meta.push(`- **Turns:** ${conversation.turnCount}`);
    lines.push(...meta);
    lines.push("");
    lines.push("---");
    lines.push("");

    conversation.turns.forEach((turn, idx) => {
      const n = turn.index || idx + 1;
      if (turn.query) {
        lines.push(`## Question ${n}`);
        if (turn.timestamp) lines.push(`*${turn.timestamp}*`);
        lines.push("");
        lines.push(turn.query);
        lines.push("");
      }

      if (turn.answerHtml || turn.answerText) {
        lines.push(`## Answer ${n}`);
        lines.push("");
        const body = turn.answerHtml
          ? htmlToMarkdown(turn.answerHtml)
          : turn.answerText;
        lines.push(body);
        lines.push("");
      }

      if (turn.citations?.length) {
        lines.push(`### Sources`);
        lines.push("");
        turn.citations.forEach((c) => {
          const url = safeMdUrl(c.url);
          if (url) lines.push(`${c.index}. [${c.label}](${url})`);
          else lines.push(`${c.index}. ${c.label}`);
        });
        lines.push("");
      }

      lines.push("---");
      lines.push("");
    });

    if (conversation.sources?.length) {
      lines.push("## All sources");
      lines.push("");
      conversation.sources.forEach((c, i) => {
        const url = safeMdUrl(c.url);
        if (url) lines.push(`${i + 1}. [${c.label}](${url})`);
        else lines.push(`${i + 1}. ${c.label}`);
      });
      lines.push("");
    }

    return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
  }

  function toJson(conversation) {
    const payload = {
      title: conversation.title,
      date: conversation.threadDate || null,
      dateDisplay: conversation.threadDateDisplay || null,
      url: conversation.url || null,
      project: conversation.project
        ? {
            name: conversation.project,
            url: safeMdUrl(conversation.projectUrl) || conversation.projectUrl || null,
          }
        : null,
      exportedAt: conversation.exportedAt,
      turnCount: conversation.turnCount,
      turns: (conversation.turns || []).map((turn, idx) => ({
        index: turn.index || idx + 1,
        timestamp: turn.timestamp || null,
        question: turn.query || null,
        answer: turn.answerHtml
          ? htmlToMarkdown(turn.answerHtml)
          : turn.answerText || "",
        sources: (turn.citations || []).map((c) => ({
          index: c.index,
          label: c.label,
          url: safeMdUrl(c.url),
        })),
      })),
      sources: (conversation.sources || []).map((c, i) => ({
        index: i + 1,
        label: c.label,
        url: safeMdUrl(c.url),
      })),
    };
    return JSON.stringify(payload, null, 2);
  }

  function suggestedFilename(conversation, ext = "md") {
    const date =
      conversation.threadDate ||
      (conversation.exportedAt || "").slice(0, 10) ||
      "export";
    const titleForFile = (conversation.title || "")
      .replace(/[…]+$/g, "")
      .replace(/\.{2,}$/g, "")
      .trim();
    return `${date}-${slugify(titleForFile)}.${ext}`;
  }

  api.htmlToMarkdown = htmlToMarkdown;
  api.toMarkdown = toMarkdown;
  api.toJson = toJson;
  api.suggestedFilename = suggestedFilename;
  api.slugify = slugify;
})();
