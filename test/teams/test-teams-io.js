const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

// Import only the pure functions (no side effects)
const { stripHtml, escapeHtml } = require("../../src/teams/io");

describe("stripHtml", () => {
  it("removes HTML tags", () => {
    assert.equal(stripHtml("<p>hello</p>"), "hello");
  });

  it("handles nested tags", () => {
    assert.equal(stripHtml("<b><i>bold italic</i></b>"), "bold italic");
  });

  it("decodes HTML entities", () => {
    assert.equal(stripHtml("&amp; &lt; &gt; &quot; &#39;"), '& < > " \'');
  });

  it("handles nbsp", () => {
    assert.equal(stripHtml("hello&nbsp;world"), "hello world");
  });

  it("returns empty string for null/undefined", () => {
    assert.equal(stripHtml(null), "");
    assert.equal(stripHtml(undefined), "");
    assert.equal(stripHtml(""), "");
  });

  it("trims whitespace", () => {
    assert.equal(stripHtml("  hello  "), "hello");
  });

  it("handles complex Teams message HTML", () => {
    const html = '<div><p>Check this <b>code</b>:</p><pre>const x = 1;</pre></div>';
    assert.equal(stripHtml(html), "Check this code:const x = 1;");
  });
});

describe("escapeHtml", () => {
  it("escapes ampersand", () => {
    assert.equal(escapeHtml("a & b"), "a &amp; b");
  });

  it("escapes angle brackets", () => {
    assert.equal(escapeHtml("<script>"), "&lt;script&gt;");
  });

  it("handles empty string", () => {
    assert.equal(escapeHtml(""), "");
  });

  it("leaves safe characters alone", () => {
    assert.equal(escapeHtml("hello world 123"), "hello world 123");
  });
});
