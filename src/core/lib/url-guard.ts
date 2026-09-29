// 抓取第三方地址（链接预览、og:image）前的检查：只允许公网 http(s)，重定向逐跳重新检查。
// 只看 URL 本身（不做 DNS 解析，保持平台无关）：挡住 localhost / 内网 IP 字面量 / 云元数据地址。

function isPrivateIPv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // 链路本地 / 云元数据
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

function isPrivateIPv6(host: string): boolean {
  if (!host.startsWith("[")) return false;
  const h = host.slice(1, -1).toLowerCase();
  if (h === "::" || h === "::1") return true;
  if (/^f[cd]/.test(h) || /^fe[89ab]/.test(h)) return true; // ULA / 链路本地
  // IPv4 映射地址：URL 会把 ::ffff:127.0.0.1 规范化成 ::ffff:7f00:1
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
  if (dotted) return isPrivateIPv4(dotted[1]!);
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (hex) {
    const [hi, lo] = [parseInt(hex[1]!, 16), parseInt(hex[2]!, 16)];
    return isPrivateIPv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return false;
}

export function isPublicHttpUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (u.username || u.password) return false;
  // 去掉结尾的点：localhost. / foo.internal. 和不带点的写法等价，都能解析
  const host = u.hostname.toLowerCase().replace(/\.+$/, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return false;
  }
  if (!host.includes(".") && !host.startsWith("[")) return false; // 单标签主机名，多半是内网
  return !isPrivateIPv4(host) && !isPrivateIPv6(host);
}

const MAX_REDIRECTS = 4;

/** 带地址检查的 fetch：手动跟随重定向，每一跳都检查；不合格返回 null。url 为重定向后的最终地址 */
export async function guardedFetch(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit = {},
): Promise<{ response: Response; url: string } | null> {
  let current = url;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    if (!isPublicHttpUrl(current)) return null;
    const response = await fetchFn(current, { ...init, redirect: "manual" });
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      response.body?.cancel().catch(() => {});
      current = new URL(location, current).href;
      continue;
    }
    return { response, url: current };
  }
  return null;
}
