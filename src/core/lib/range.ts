import type { ByteRange } from "../ports";

/** 把请求的区间收敛到 [0, size) 内；无法满足时返回 null */
export function resolveRange(range: ByteRange, size: number): { offset: number; length: number } | null {
  if ("suffix" in range) {
    const length = Math.min(range.suffix, size);
    return length > 0 ? { offset: size - length, length } : null;
  }
  if (range.offset >= size) return null;
  const length = Math.min(range.length ?? size - range.offset, size - range.offset);
  return length > 0 ? { offset: range.offset, length } : null;
}
