import test from "node:test";
import assert from "node:assert/strict";

const {
  isMarkdownPath,
  isHtmlPath,
  markdownToHtml,
  buildPreviewDocument,
  composeHtmlDocument,
  pickTopicDefaultRelPath
} = await import("../.tmp-tests/editorContent.js");

test("path helpers detect markdown/html extensions case-insensitively", () => {
  assert.equal(isMarkdownPath("master.MD"), true);
  assert.equal(isMarkdownPath("notes.markdown"), true);
  assert.equal(isMarkdownPath("notes.txt"), false);

  assert.equal(isHtmlPath("email.HTML"), true);
  assert.equal(isHtmlPath("landing.htm"), true);
  assert.equal(isHtmlPath("landing.md"), false);
});

test("markdown renderer converts heading/list/code/link", () => {
  const html = markdownToHtml("# Title\n\n- One\n- Two\n\nA [link](https://example.com) and `code`.");
  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<ul>/);
  assert.match(html, /<li>One<\/li>/);
  assert.match(html, /<a href=\"https:\/\/example\.com\"/);
  assert.match(html, /<code>code<\/code>/);
});

test("preview builder wraps markdown and escapes plain text", () => {
  const mdPreview = buildPreviewDocument("## Hello", "master.md");
  assert.match(mdPreview, /<!doctype html>/i);
  assert.match(mdPreview, /<h2>Hello<\/h2>/);

  const txtPreview = buildPreviewDocument("<script>alert(1)</script>", "notes.txt");
  assert.doesNotMatch(txtPreview, /<script>alert\(1\)<\/script>/);
  assert.match(txtPreview, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test("composeHtmlDocument outputs full and fragment shapes", () => {
  const full = composeHtmlDocument("<main>x</main>", "body{color:red;}", true);
  assert.match(full, /<!doctype html>/i);
  assert.match(full, /<style>/);
  assert.match(full, /<main>x<\/main>/);

  const fragment = composeHtmlDocument("<p>x</p>", "", false);
  assert.equal(fragment.trim(), "<p>x</p>");
});

test("composeHtmlDocument preserves document shell assets for GrapesJS roundtrip", () => {
  const composed = composeHtmlDocument(
    "<section class=\"hero\">Updated</section>",
    ".hero{padding:24px}",
    true,
    {
      headHtml: "<meta charset=\"utf-8\" /><link rel=\"stylesheet\" href=\"./email.css\" /><style>.old{display:none}</style>",
      htmlAttrs: " data-theme=\"dockhub\"",
      bodyAttrs: " class=\"email-body\""
    }
  );
  assert.match(composed, /<html data-theme="dockhub">/);
  assert.match(composed, /<body class="email-body">/);
  assert.match(composed, /<link[^>]+email\.css/);
  assert.match(composed, /\.old\{display:none\}/);
  assert.match(composed, /<style>\s*\.hero\{padding:24px\}/);
});

test("pickTopicDefaultRelPath prefers master then first derivative", () => {
  assert.equal(
    pickTopicDefaultRelPath({ masterFile: "master.md", derivatives: [{ relPath: "email.html" }] }),
    "master.md"
  );
  assert.equal(
    pickTopicDefaultRelPath({ masterFile: null, derivatives: [{ relPath: "email.html" }] }),
    "email.html"
  );
  assert.equal(
    pickTopicDefaultRelPath({ masterFile: null, derivatives: [] }),
    null
  );
});
