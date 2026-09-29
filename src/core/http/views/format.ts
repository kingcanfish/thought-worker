import { dayKey, pad2 } from "../../lib/time";
import type { PostView } from "../../services/timeline";

export const WEEKDAY_CN = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

export interface DayGroup {
  key: string;
  posts: PostView[];
}

export function groupByDay(posts: PostView[], tz: string): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const p of posts) {
    const key = dayKey(p.createdAt, tz);
    const last = groups[groups.length - 1];
    if (last?.key === key) last.posts.push(p);
    else groups.push({ key, posts: [p] });
  }
  return groups;
}

export const formatDuration = (s: number): string => `${Math.floor(s / 60)}:${pad2(Math.floor(s % 60))}`;

/** 纯文本摘要（OG 描述、RSS 标题） */
export const excerpt = (text: string, max: number): string => {
  const s = text.replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};
