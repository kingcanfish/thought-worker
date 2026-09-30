// 构建端的图片压缩（sharp）：转成 WebP，限制最长边和文件大小。核心代码只依赖 ImageOptimizer 接口
import sharp from "sharp";
import type { ImageOptimizer } from "../core/ports";

/** GIF 可能是动图，HEIC 等浏览器不一定能显示的格式本来就不会转存，都不处理 */
const INPUT = new Set(["image/jpeg", "image/png", "image/webp"]);

/** 超过大小上限时，质量最低降到这里，再往下就改为缩小尺寸 */
const MIN_QUALITY = 50;
/** 尺寸每次缩小的比例，最短缩到这个最长边为止 */
const SHRINK = 0.8;
const MIN_SIDE = 640;

export interface ImageOptions {
  /** WebP 质量 1~100 */
  quality: number;
  /** 最长边超过就等比缩小；Telegram 压缩过的照片最长 2560，主要影响「以文件发送」的原图 */
  maxSide: number;
  /** 压缩后的文件大小上限（字节）：先降质量，再缩尺寸 */
  maxBytes: number;
}

export function createImageOptimizer({ quality, maxSide, maxBytes }: ImageOptions): ImageOptimizer {
  return async (bytes, mime) => {
    if (!INPUT.has(mime)) return null;
    // 先解码并转正一次，之后每轮只重新编码
    const { data, info } = await sharp(bytes, { failOn: "none" })
      .rotate() // 按 EXIF 方向转正；输出默认不带 EXIF（原图里的 GPS 等信息一并去掉）
      .raw()
      .toBuffer({ resolveWithObject: true });
    const source = () => sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } });

    let side = Math.min(maxSide, Math.max(info.width, info.height));
    let q = quality;
    for (;;) {
      const out = await source()
        .resize({ width: side, height: side, fit: "inside", withoutEnlargement: true })
        .webp({ quality: q, smartSubsample: true })
        .toBuffer();
      if (out.byteLength <= maxBytes || side <= MIN_SIDE) return { bytes: new Uint8Array(out), mime: "image/webp" };
      if (q > MIN_QUALITY) q = Math.max(MIN_QUALITY, q - 10);
      else side = Math.max(MIN_SIDE, Math.round(side * SHRINK));
    }
  };
}
