export function isMarkdownPath(path: string | null): boolean {
  if (!path) return false;
  const lower = path.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".markdown");
}

export function isHtmlPath(path: string | null): boolean {
  if (!path) return false;
  const lower = path.toLowerCase();
  return lower.endsWith(".html") || lower.endsWith(".htm");
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function inlineMarkdown(source: string): string {
  const escaped = escapeHtml(source);
  return escaped
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
}

function previewScrollbarCss(theme: "light" | "dark"): string {
  const dark = theme === "dark";
  const thumbColor = dark ? "#475569" : "#94a3b8";
  return `
* {
  scrollbar-width: thin;
  scrollbar-color: ${thumbColor} transparent;
}
*::-webkit-scrollbar {
  width: 10px;
  height: 10px;
}
*::-webkit-scrollbar-track {
  background: transparent;
  border-radius: 999px;
  margin-block: 6px;
  margin-inline: 1%;
}
*::-webkit-scrollbar-thumb {
  background: ${thumbColor};
  border: 3px solid transparent;
  background-clip: padding-box;
  border-radius: 999px;
  min-height: 24px;
}`;
}

export function markdownToHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let inList = false;
  let inCode = false;
  const closeList = () => {
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
  };
  for (const raw of lines) {
    if (raw.startsWith("```")) {
      closeList();
      if (!inCode) {
        out.push("<pre><code>");
        inCode = true;
      } else {
        out.push("</code></pre>");
        inCode = false;
      }
      continue;
    }
    if (inCode) {
      out.push(`${escapeHtml(raw)}\n`);
      continue;
    }
    const line = raw.trim();
    if (!line) {
      closeList();
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      closeList();
      const level = heading[1].length;
      out.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }
    const list = line.match(/^[-*]\s+(.+)$/);
    if (list) {
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${inlineMarkdown(list[1])}</li>`);
      continue;
    }
    closeList();
    out.push(`<p>${inlineMarkdown(line)}</p>`);
  }
  closeList();
  if (inCode) out.push("</code></pre>");
  return out.join("\n");
}

function buildHtmlThemeOverride(theme: "light" | "dark"): string {
  const dark = theme === "dark";
  const bodyBg = dark ? "#020617" : "#ffffff";
  const bodyColor = dark ? "#e2e8f0" : "#0f172a";
  const linkColor = dark ? "#93c5fd" : "#0369a1";
  const codeBg = dark ? "#111827" : "#f1f5f9";
  const borderColor = dark ? "#334155" : "#cbd5e1";
  return `<meta name="color-scheme" content="${dark ? "dark" : "light"}" />
<style id="content-shotgun-preview-theme">
:root { color-scheme: ${dark ? "dark" : "light"} !important; }
html, body {
  background: ${bodyBg} !important;
  color: ${bodyColor} !important;
}
body, body * {
  color: ${bodyColor} !important;
}
a, a * {
  color: ${linkColor} !important;
}
pre, code, kbd, samp {
  background: ${codeBg} !important;
  color: ${bodyColor} !important;
}
table, th, td, hr {
  border-color: ${borderColor} !important;
}
${previewScrollbarCss(theme)}
</style>`;
}

function applyThemeOverrideToHtml(content: string, theme: "light" | "dark"): string {
  const override = buildHtmlThemeOverride(theme);
  const hasHtmlShell = /<html[\s>]/i.test(content) || /<!doctype/i.test(content);
  if (!hasHtmlShell) {
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  ${override}
</head>
<body>
${content}
</body>
</html>`;
  }

  if (/<\/head>/i.test(content)) {
    return content.replace(/<\/head>/i, `${override}\n</head>`);
  }

  if (/<html[\s>][^>]*>/i.test(content)) {
    return content.replace(/<html[\s>][^>]*>/i, (match) => `${match}\n<head>\n${override}\n</head>`);
  }

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  ${override}
</head>
<body>
${content}
</body>
</html>`;
}

export function buildPreviewDocument(content: string, relPath: string | null, theme: "light" | "dark" = "light"): string {
  if (isHtmlPath(relPath)) return applyThemeOverrideToHtml(content, theme);
  if (isMarkdownPath(relPath)) {
    const dark = theme === "dark";
    const bodyBg = dark ? "#020617" : "#ffffff";
    const bodyColor = dark ? "#e2e8f0" : "#0f172a";
    const codeBg = dark ? "#111827" : "#f1f5f9";
    const preBg = dark ? "#0b1220" : "#f8fafc";
    const preBorder = dark ? "#334155" : "#dbe3ee";
    const linkColor = dark ? "#93c5fd" : "#0369a1";
    const rendered = markdownToHtml(content);
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="color-scheme" content="${dark ? "dark" : "light"}" />
  <style>
    ${previewScrollbarCss(theme)}
    body {
      margin: 0;
      padding: 18px 22px;
      font: 15px/1.6 "IBM Plex Sans", system-ui, sans-serif;
      color: ${bodyColor};
      background: ${bodyBg};
    }
    h1, h2, h3, h4, h5, h6 { margin: 1.1em 0 0.45em; line-height: 1.25; }
    p { margin: 0.55em 0; }
    ul { margin: 0.55em 0 0.55em 1.25em; }
    code {
      font-family: "IBM Plex Mono", ui-monospace, monospace;
      background: ${codeBg};
      border-radius: 6px;
      padding: 0.08rem 0.34rem;
    }
    pre {
      overflow: auto;
      border-radius: 10px;
      padding: 0.7rem 0.85rem;
      border: 1px solid ${preBorder};
      background: ${preBg};
    }
    pre code { background: transparent; padding: 0; }
    a { color: ${linkColor}; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
${rendered || "<p></p>"}
</body>
</html>`;
  }
  const dark = theme === "dark";
  const bodyBg = dark ? "#020617" : "#ffffff";
  const bodyColor = dark ? "#e2e8f0" : "#0f172a";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="color-scheme" content="${dark ? "dark" : "light"}" />
  <style>
    ${previewScrollbarCss(theme)}
    body {
      margin: 0;
      padding: 18px 22px;
      font: 14px/1.5 "IBM Plex Mono", ui-monospace, monospace;
      color: ${bodyColor};
      background: ${bodyBg};
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
  </style>
</head>
<body>${escapeHtml(content)}</body>
</html>`;
}

export interface ParsedHtmlContent {
  html: string;
  css: string;
  isFullDocument: boolean;
  headHtml: string;
  htmlAttrs: string;
  bodyAttrs: string;
}

export interface PreservedHtmlDocumentShell {
  headHtml: string;
  htmlAttrs: string;
  bodyAttrs: string;
}

function escapeAttributeValue(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;");
}

function serializeElementAttrs(element: Element | null): string {
  if (!element) return "";
  return Array.from(element.attributes)
    .map((attr) => ` ${attr.name}="${escapeAttributeValue(attr.value)}"`)
    .join("");
}

export function splitHtmlAndCss(source: string): ParsedHtmlContent {
  const doc = new DOMParser().parseFromString(source, "text/html");
  const styleTags = Array.from(doc.querySelectorAll("style"));
  const css = styleTags.map((tag) => tag.textContent ?? "").join("\n").trim();
  const isFullDocument = /<html[\s>]/i.test(source) || /<!doctype/i.test(source);
  const bodyHtml = doc.body?.innerHTML?.trim() ?? "";
  return {
    html: bodyHtml || source,
    css,
    isFullDocument,
    headHtml: isFullDocument ? (doc.head?.innerHTML ?? "") : "",
    htmlAttrs: isFullDocument ? serializeElementAttrs(doc.documentElement) : "",
    bodyAttrs: isFullDocument ? serializeElementAttrs(doc.body) : ""
  };
}

export function composeHtmlDocument(
  html: string,
  css: string,
  asFullDocument: boolean,
  preservedShell: PreservedHtmlDocumentShell | null = null
): string {
  if (!asFullDocument) {
    if (!css.trim()) return html;
    return `<style>\n${css}\n</style>\n${html}`;
  }

  const savedHead = (preservedShell?.headHtml ?? "").trim();
  const hasCharsetMeta = /<meta[^>]*charset=/i.test(savedHead);
  const htmlAttrs = preservedShell?.htmlAttrs || ' lang="en"';
  const bodyAttrs = preservedShell?.bodyAttrs ?? "";
  const styleBlock = css.trim() ? `\n<style>\n${css}\n</style>` : "";
  const charsetMeta = hasCharsetMeta ? "" : '\n<meta charset="utf-8" />';
  const headBody = `${charsetMeta}${savedHead ? `\n${savedHead}` : ""}${styleBlock}`;

  return `<!doctype html>
<html${htmlAttrs}>
<head>
${headBody}
</head>
<body${bodyAttrs}>
${html}
</body>
</html>
`;
}

export function pickTopicDefaultRelPath(topic: { masterFile: string | null; derivatives: Array<{ relPath: string }> }): string | null {
  if (topic.masterFile) return topic.masterFile;
  return topic.derivatives[0]?.relPath ?? null;
}
