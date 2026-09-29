import { describe, expect, it } from "vitest";
import { imageSize } from "../src/core/lib/image-size";
import { parseLinkMeta } from "../src/core/services/link-meta";
import { pngBytes } from "./helpers";

describe("parseLinkMeta", () => {
  it("reads og tags, decodes entities and resolves relative images", () => {
    const meta = parseLinkMeta(
      `<html><head><title>fallback</title>
       <meta property="og:title" content="Hello &amp; welcome">
       <meta content='A &quot;nice&quot; page' name="description">
       <meta property="og:image" content="/cover.png">
       <meta property="og:site_name" content="Example">
       </head><body><meta property="og:title" content="ignored"></body></html>`,
      "https://example.com/post/1",
    );
    expect(meta).toMatchObject({
      title: "Hello & welcome",
      description: 'A "nice" page',
      image: "https://example.com/cover.png",
      siteName: "Example",
    });
  });

  it("falls back to <title> and hostname", () => {
    const meta = parseLinkMeta("<title> Just a title </title>", "https://www.example.org/");
    expect(meta.title).toBe("Just a title");
    expect(meta.siteName).toBe("example.org");
    expect(meta.image).toBeNull();
  });
});

describe("imageSize", () => {
  it("reads png and gif headers", () => {
    expect(imageSize(pngBytes(1200, 630))).toEqual({ width: 1200, height: 630, mime: "image/png" });
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x40, 0x01, 0xf0, 0x00, 0, 0, 0, 0, 0, 0]);
    expect(imageSize(gif)).toEqual({ width: 320, height: 240, mime: "image/gif" });
  });

  it("reads jpeg SOF", () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03]);
    expect(imageSize(jpeg)).toEqual({ width: 640, height: 480, mime: "image/jpeg" });
  });

  it("returns null for unknown data", () => {
    expect(imageSize(new Uint8Array(32))).toBeNull();
  });
});
