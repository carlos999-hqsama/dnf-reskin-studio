// PNG 字节 ↔ RGBA — 浏览器 Canvas 解/编。wasm 解出/吃进的帧都是 PNG; core 的几何/去背/合成吃 RGBA。
import type { RGBA } from './model';

/** PNG 字节 → RGBA (ImageData)。createImageBitmap + Canvas decode。 */
export async function decodePng(png: Uint8Array): Promise<ImageData> {
  const bmp = await createImageBitmap(new Blob([new Uint8Array(png)], { type: 'image/png' }));
  const cv = document.createElement('canvas');
  cv.width = bmp.width;
  cv.height = bmp.height;
  const ctx = cv.getContext('2d')!;
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  return ctx.getImageData(0, 0, cv.width, cv.height);
}

/** RGBA → PNG 字节 — Canvas.toBlob('image/png')。回封前把硬边化后的替换帧编码成 PNG 喂 wasm
 *  (do_repack 的 libpng loadPNG 读标准 PNG)。⚠️ Canvas 存的是 premultiplied alpha, 往返对
 *  半透明像素有损; 但替换帧已 conformToDnf 二值化 (alpha 只 0/255), alpha=255 时 RGB 无损、
 *  alpha=0 的透明像素 RGB 本就不参与编码 → 对 DNF 硬边精灵无损。 */
export async function encodePng(img: RGBA): Promise<Uint8Array> {
  const cv = document.createElement('canvas');
  cv.width = img.width;
  cv.height = img.height;
  const ctx = cv.getContext('2d')!;
  // new Uint8ClampedArray(copy): TS5.7 下 RGBA.data 是 Uint8ClampedArray<ArrayBufferLike>,
  // ImageData 构造要 ArrayBuffer(非 SharedArrayBuffer) → copy 一份固定 backing buffer。
  ctx.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => cv.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('canvas.toBlob 返回空 (PNG 编码失败)');
  return new Uint8Array(await blob.arrayBuffer());
}
