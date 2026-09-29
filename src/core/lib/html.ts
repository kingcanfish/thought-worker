const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);

const SAFE_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);

/** 只放行 http(s) / mailto / tel，其余（javascript: 等）返回 null */
export function safeUrl(url: string): string | null {
  try {
    const u = new URL(url);
    return SAFE_PROTOCOLS.has(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** 解码 HTML 实体（抓取网页 meta 用） */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}
