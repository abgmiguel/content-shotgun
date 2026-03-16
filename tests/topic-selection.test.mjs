import test from "node:test";
import assert from "node:assert/strict";

const {
  resolveSelectedTopicSlug,
  resolveSelectedRelPath,
  topicContainsRelPath
} = await import("../.tmp-tests/topicSelection.js");

function makeTopic(overrides = {}) {
  return {
    slug: "alpha",
    masterFile: "master.md",
    derivatives: [{ relPath: "derivatives/email.md" }, { relPath: "derivatives/blog.html" }],
    assets: [{ relPath: "assets/hero.png" }],
    ...overrides
  };
}

test("resolveSelectedTopicSlug picks first topic for empty/invalid selection", () => {
  const topics = [{ slug: "first" }, { slug: "second" }];
  assert.equal(resolveSelectedTopicSlug(topics, null), "first");
  assert.equal(resolveSelectedTopicSlug(topics, "missing"), "first");
});

test("resolveSelectedTopicSlug keeps valid selection", () => {
  const topics = [{ slug: "first" }, { slug: "second" }];
  assert.equal(resolveSelectedTopicSlug(topics, "second"), "second");
});

test("resolveSelectedRelPath keeps valid selected file", () => {
  const topic = makeTopic();
  assert.equal(resolveSelectedRelPath(topic, "derivatives/email.md"), "derivatives/email.md");
  assert.equal(resolveSelectedRelPath(topic, "assets/hero.png"), "assets/hero.png");
});

test("resolveSelectedRelPath falls back to topic default for invalid path", () => {
  const topic = makeTopic();
  assert.equal(resolveSelectedRelPath(topic, "missing.md"), "master.md");
});

test("resolveSelectedRelPath falls back to first derivative when no master exists", () => {
  const topic = makeTopic({ masterFile: null });
  assert.equal(resolveSelectedRelPath(topic, "missing.md"), "derivatives/email.md");
});

test("topicContainsRelPath detects membership across master, derivatives, and assets", () => {
  const topic = makeTopic();
  assert.equal(topicContainsRelPath(topic, "master.md"), true);
  assert.equal(topicContainsRelPath(topic, "derivatives/blog.html"), true);
  assert.equal(topicContainsRelPath(topic, "assets/hero.png"), true);
  assert.equal(topicContainsRelPath(topic, "nope"), false);
});
