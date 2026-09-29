// 从文件头读出图片尺寸（PNG / GIF / WebP / JPEG），不依赖图片解码库

export interface ImageInfo {
  width: number;
  height: number;
  mime: string;
}

const ascii = (b: Uint8Array, start: number, end: number): string => String.fromCharCode(...b.subarray(start, end));
const u16be = (b: Uint8Array, i: number): number => (b[i]! << 8) | b[i + 1]!;
const u16le = (b: Uint8Array, i: number): number => b[i]! | (b[i + 1]! << 8);
const u24le = (b: Uint8Array, i: number): number => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);
const u32be = (b: Uint8Array, i: number): number => ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0;
const u32le = (b: Uint8Array, i: number): number => (b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16) | (b[i + 3]! << 24)) >>> 0;

export function imageSize(b: Uint8Array): ImageInfo | null {
  if (b.length < 16) return null;

  if (b[0] === 0x89 && ascii(b, 1, 4) === "PNG" && b.length >= 24) {
    return { width: u32be(b, 16), height: u32be(b, 20), mime: "image/png" };
  }
  if (ascii(b, 0, 3) === "GIF") {
    return { width: u16le(b, 6), height: u16le(b, 8), mime: "image/gif" };
  }
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP" && b.length >= 30) {
    const chunk = ascii(b, 12, 16);
    if (chunk === "VP8 ") return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff, mime: "image/webp" };
    if (chunk === "VP8L") {
      const bits = u32le(b, 21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, mime: "image/webp" };
    }
    if (chunk === "VP8X") return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1, mime: "image/webp" };
    return null;
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = b[i + 1]!;
      if (marker === 0xff) {
        i++;
        continue;
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      // SOF0~SOF15（排除 DHT / JPG / DAC）里存着尺寸
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: u16be(b, i + 5), width: u16be(b, i + 7), mime: "image/jpeg" };
      }
      i += 2 + u16be(b, i + 2);
    }
  }
  return null;
}
