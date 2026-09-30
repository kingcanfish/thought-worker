// 构建端的图片压缩（sharp）：转成 WebP，限制最长边和文件大小。核心代码只依赖 ImageOptimizer 接口
import sharp from "sharp";
import type { ImageOptimizer } from "../core/ports";
import { OPTIMIZABLE_IMAGES } from "../core/services/media";

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
    if (!OPTIMIZABLE_IMAGES.has(mime)) return null;
    const input = sharp(bytes, { failOn: "none" });
    // 动图 WebP / APNG：sharp 默认只解码第一帧，压出来就成了静态图，保留原图
    if (((await input.metadata()).pages ?? 1) > 1) return null;

    // 解码、转正、先缩到最长边以内，只做一次；之后每轮从这份像素重新编码，不必每次处理全尺寸原图
    const { data, info } = await input
      .rotate() // 按 EXIF 方向转正；输出默认不带 EXIF（原图里的 GPS 等信息一并去掉）
      .resize({ width: maxSide, height: maxSide, fit: "inside", withoutEnlargement: true })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const pixels = () => sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } });

    const full = Math.max(info.width, info.height);
    let side = full;
    let q = quality;
    for (;;) {
      const img = side < full ? pixels().resize({ width: side, height: side, fit: "inside" }) : pixels();
      const out = await img.webp({ quality: q, smartSubsample: true }).toBuffer();
      if (out.byteLength <= maxBytes || side <= MIN_SIDE) {
        return out.byteLength < bytes.byteLength ? { bytes: new Uint8Array(out), mime: "image/webp" } : null;
      }
      if (q > MIN_QUALITY) q = Math.max(MIN_QUALITY, q - 10);
      else side = Math.max(MIN_SIDE, Math.round(side * SHRINK));
    }
  };
}
