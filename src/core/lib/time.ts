// 按站点时区（IANA 名）处理日期。「日期键」统一是 YYYY-MM-DD 字符串，时间戳是 unix 秒。

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    formatters.set(tz, f);
  }
  return f;
}

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = 周日 */
  weekday: number;
}

export function zonedParts(ts: number, tz: string): ZonedParts {
  const o: Record<string, string> = {};
  for (const p of formatter(tz).formatToParts(new Date(ts * 1000))) o[p.type] = p.value;
  return {
    year: Number(o.year),
    month: Number(o.month),
    day: Number(o.day),
    hour: Number(o.hour),
    minute: Number(o.minute),
    second: Number(o.second),
    weekday: WEEKDAYS.indexOf(o.weekday ?? ""),
  };
}

export const pad2 = (n: number): string => String(n).padStart(2, "0");

export const toDayKey = (y: number, m: number, d: number): string => `${y}-${pad2(m)}-${pad2(d)}`;

export function dayKey(ts: number, tz: string): string {
  const p = zonedParts(ts, tz);
  return toDayKey(p.year, p.month, p.day);
}

export function timeOfDay(ts: number, tz: string): string {
  const p = zonedParts(ts, tz);
  return `${pad2(p.hour)}:${pad2(p.minute)}`;
}

/** 该时刻在 tz 下相对 UTC 的偏移（秒），东八区为 28800 */
export function tzOffset(ts: number, tz: string): number {
  const p = zonedParts(ts, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) / 1000 - ts;
}

const DAY_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseDayKey(key: string): [number, number, number] | null {
  const m = DAY_KEY_RE.exec(key);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d ? [y, mo, d] : null;
}

export const isDayKey = (s: string | undefined | null): s is string => !!s && parseDayKey(s) !== null;

/** tz 下某天 00:00 对应的 unix 秒（两次迭代，夏令时切换日也准确） */
export function dayStart(key: string, tz: string): number {
  const p = parseDayKey(key);
  if (!p) throw new Error(`invalid day key: ${key}`);
  const wall = Date.UTC(p[0], p[1] - 1, p[2]) / 1000;
  const first = wall - tzOffset(wall, tz);
  return wall - tzOffset(first, tz);
}

export function addDays(key: string, n: number): string {
  const p = parseDayKey(key);
  if (!p) throw new Error(`invalid day key: ${key}`);
  const dt = new Date(Date.UTC(p[0], p[1] - 1, p[2] + n));
  return toDayKey(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

/** 0 = 周日 */
export function weekdayOf(key: string): number {
  const p = parseDayKey(key);
  if (!p) throw new Error(`invalid day key: ${key}`);
  return new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay();
}

export const nowSeconds = (): number => Math.floor(Date.now() / 1000);
