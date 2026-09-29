import { describe, expect, it } from "vitest";
import { extractTags, firstLink, renderEntities } from "../src/core/telegram/entities";

const opts = { tagHref: (t: string) => `/?tag=${encodeURIComponent(t)}` };

describe("renderEntities", () => {
  it("escapes plain text", () => {
    expect(renderEntities("a < b & c", [], opts)).toBe("a &lt; b &amp; c");
  });

  it("renders nested entities", () => {
    const html = renderEntities("hello world", [
      { type: "bold", offset: 0, length: 11 },
      { type: "italic", offset: 6, length: 5 },
    ], opts);
    expect(html).toBe("<strong>hello <em>world</em></strong>");
  });

  it("uses UTF-16 offsets so emoji do not shift entities", () => {
    // 😀 占 2 个 code unit
    expect(renderEntities("😀 bold", [{ type: "bold", offset: 3, length: 4 }], opts)).toBe("😀 <strong>bold</strong>");
  });

  it("drops unsafe links", () => {
    const html = renderEntities("click", [{ type: "text_link", offset: 0, length: 5, url: "javascript:alert(1)" }], opts);
    expect(html).toBe("click");
  });

  it("links urls, mentions and hashtags", () => {
    const text = "see example.com @someone #日常";
    const html = renderEntities(text, [
      { type: "url", offset: 4, length: 11 },
      { type: "mention", offset: 16, length: 8 },
      { type: "hashtag", offset: 25, length: 3 },
    ], opts);
    expect(html).toContain('<a href="https://example.com/" target="_blank" rel="noopener nofollow">example.com</a>');
    expect(html).toContain('<a href="https://t.me/someone"');
    expect(html).toContain(`<a class="hashtag" href="/?tag=${encodeURIComponent("日常")}">#日常</a>`);
  });

  it("renders code blocks without nested formatting and trims block newlines", () => {
    const text = "before\nconst a = 1;\nafter";
    const html = renderEntities(text, [{ type: "pre", offset: 7, length: 12, language: "js" }], opts);
    expect(html).toBe('before<pre><code class="language-js">const a = 1;</code></pre>after');
  });

  it("ignores partially overlapping entities instead of producing broken html", () => {
    const html = renderEntities("abcdef", [
      { type: "bold", offset: 0, length: 4 },
      { type: "italic", offset: 2, length: 4 },
    ], opts);
    expect(html).toBe("<strong>ab<em>cd</em></strong>ef");
  });
});

describe("extractTags / firstLink", () => {
  it("dedupes hashtags and strips @suffix", () => {
    const text = "#a #b@chan #a";
    expect(extractTags(text, [
      { type: "hashtag", offset: 0, length: 2 },
      { type: "hashtag", offset: 3, length: 7 },
      { type: "hashtag", offset: 11, length: 2 },
    ])).toEqual(["a", "b"]);
  });

  it("finds the first http link", () => {
    const text = "mail a@b.co then docs.dev";
    expect(firstLink(text, [
      { type: "email", offset: 5, length: 6 },
      { type: "url", offset: 17, length: 8 },
    ])).toBe("https://docs.dev/");
  });
});
