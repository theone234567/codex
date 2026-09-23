// On-device photo processing. All free: no AI tokens and no server work.
import { cropRect, fitWithin, levelsLut } from "./imageMath";
import type { Crop } from "./types";

export const MAIN_EDGE = 2048; // stored photo (good for Trade Me)
export const THUMB_EDGE = 400; // grid thumbnails
export const AI_EDGE = 768; // what the AI sees - small = fewer tokens (~600 per photo)

function canvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

function ctx2d(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas not supported");
  return ctx;
}

function toJpeg(c: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    c.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not encode photo"))), "image/jpeg", quality),
  );
}

async function decode(source: Blob): Promise<ImageBitmap> {
  // Honour the phone's EXIF rotation so photos are the right way up.
  return createImageBitmap(source, { imageOrientation: "from-image" });
}

/** Auto brightness/contrast/white balance, in place. */
function autoEnhance(c: HTMLCanvasElement): void {
  const ctx = ctx2d(c);
  // histogram from a small copy (fast)
  const small = fitWithin(c.width, c.height, 256);
  const s = canvas(small.w, small.h);
  ctx2d(s).drawImage(c, 0, 0, small.w, small.h);
  const sd = ctx2d(s).getImageData(0, 0, small.w, small.h).data;
  const hr = new Uint32Array(256), hg = new Uint32Array(256), hb = new Uint32Array(256);
  for (let i = 0; i < sd.length; i += 4) { hr[sd[i]]++; hg[sd[i + 1]]++; hb[sd[i + 2]]++; }
  const total = small.w * small.h;
  const lr = levelsLut(hr, total), lg = levelsLut(hg, total), lb = levelsLut(hb, total);
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) { d[i] = lr[d[i]]; d[i + 1] = lg[d[i + 1]]; d[i + 2] = lb[d[i + 2]]; }
  ctx.putImageData(img, 0, 0);
}

export interface Processed { main: Blob; thumb: Blob; width: number; height: number }

/** Resize, straighten orientation, tidy colours, compress. */
export async function processPhoto(source: Blob, enhance = true): Promise<Processed> {
  const bmp = await decode(source);
  const size = fitWithin(bmp.width, bmp.height, MAIN_EDGE);
  const c = canvas(size.w, size.h);
  const ctx = ctx2d(c);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp, 0, 0, size.w, size.h);
  bmp.close();
  if (enhance) autoEnhance(c);
  const main = await toJpeg(c, 0.85);
  const t = fitWithin(size.w, size.h, THUMB_EDGE);
  const tc = canvas(t.w, t.h);
  ctx2d(tc).drawImage(c, 0, 0, t.w, t.h);
  const thumb = await toJpeg(tc, 0.7);
  return { main, thumb, width: size.w, height: size.h };
}

/** Small JPEG as base64 for the AI request. */
export async function aiImageBase64(source: Blob): Promise<string> {
  const bmp = await decode(source);
  const size = fitWithin(bmp.width, bmp.height, AI_EDGE);
  const c = canvas(size.w, size.h);
  ctx2d(c).drawImage(bmp, 0, 0, size.w, size.h);
  bmp.close();
  const blob = await toJpeg(c, 0.7);
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Final photo for Trade Me with the chosen crop and rotation applied. */
export async function renderFinal(source: Blob, rotation: number, crop: Crop | null): Promise<Blob> {
  const bmp = await decode(source);
  const r = cropRect(bmp.width, bmp.height, crop);
  const swap = rotation === 90 || rotation === 270;
  const c = canvas(swap ? r.sh : r.sw, swap ? r.sw : r.sh);
  const ctx = ctx2d(c);
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate((rotation * Math.PI) / 180);
  ctx.drawImage(bmp, r.sx, r.sy, r.sw, r.sh, -r.sw / 2, -r.sh / 2, r.sw, r.sh);
  bmp.close();
  return toJpeg(c, 0.9);
}

/** Try to read a barcode on-device (Chrome/Android). Free, and helps the AI identify DVDs/books. */
export async function readBarcode(source: Blob): Promise<string> {
  const BD = (globalThis as unknown as { BarcodeDetector?: new (o: object) => { detect(i: ImageBitmap): Promise<{ rawValue: string }[]> } }).BarcodeDetector;
  if (!BD) return "";
  try {
    const bmp = await decode(source);
    const found = await new BD({ formats: ["ean_13", "ean_8", "upc_a", "upc_e", "code_128"] }).detect(bmp);
    bmp.close();
    const v = found[0]?.rawValue ?? "";
    return /^[0-9A-Za-z-]{4,32}$/.test(v) ? v : "";
  } catch {
    return "";
  }
}
