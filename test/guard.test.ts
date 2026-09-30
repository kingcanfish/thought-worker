import { describe, expect, it } from "vitest";
import { guardedFetch, isPublicHttpUrl } from "../src/core/lib/url-guard";

describe("isPublicHttpUrl", () => {
  it.each([
    "http://localhost/",
    "http://127.0.0.1:8080/",
    "http://10.0.0.1/",
    "http://172.16.5.1/",
    "http://192.168.1.1/",
    "http://169.254.169.254/latest/meta-data",
    "http://100.64.0.1/",
    "http://[::1]/",
    "http://[fd00::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://intranet/",
    "http://printer.local/",
    "ftp://example.com/",
    "http://user:pass@example.com/",
    // 结尾带点的写法等价，但能绕过后缀判断
    "http://localhost.:8787/",
    "http://metadata.google.internal./",
    "http://printer.local./",
  ])("rejects %s", (url) => expect(isPublicHttpUrl(url)).toBe(false));

  it.each(["https://example.com/", "http://8.8.8.8/", "https://[2606:4700::1]/", "https://sub.example.co.jp/x?y"])("accepts %s", (url) =>
    expect(isPublicHttpUrl(url)).toBe(true),
  );
});

describe("guardedFetch", () => {
  it("re-checks every redirect hop", async () => {
    const seen: string[] = [];
    const fake: typeof fetch = async (input) => {
      const url = String(input);
      seen.push(url);
      return url === "https://example.com/go"
        ? new Response(null, { status: 302, headers: { location: "http://127.0.0.1/secret" } })
        : new Response("ok");
    };
    expect(await guardedFetch(fake, "https://example.com/go")).toBeNull();
    expect(seen).toEqual(["https://example.com/go"]);
  });

  it("returns the final url", async () => {
    const fake: typeof fetch = async (input) =>
      String(input) === "https://a.test/" ? new Response(null, { status: 301, headers: { location: "/b" } }) : new Response("ok");
    const r = await guardedFetch(fake, "https://a.test/");
    expect(r?.url).toBe("https://a.test/b");
  });
});
