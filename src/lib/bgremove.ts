// White-background photos, computed on the user's own device (free - no AI tokens, no server).
// Model: "silueta" (U2-Net, Apache-2.0) via ONNX Runtime Web. Downloaded once (~44 MB) and cached.
import * as ort from "onnxruntime-web/wasm";
import { alphaCurve, maskBox, normalizeMask } from "./imageMath";

const SIZE = 320;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];
const CACHE = "klicklist-models-v1";

let sessionPromise: Promise<ort.InferenceSession> | null = null;

async function fetchCached(url: string): Promise<ArrayBuffer> {
  try {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(url);
    if (hit) return hit.arrayBuffer();
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await cache.put(url, res.clone());
    return res.arrayBuffer();
  } catch {
    const res = await fetch(url); // Cache API unavailable (e.g. private mode)
    if (!res.ok) throw new Error(`Could not download background model (HTTP ${res.status})`);
    return res.arrayBuffer();
  }
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", data as BufferSource);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function session(): Promise<ort.InferenceSession> {
  sessionPromise ??= (async () => {
    ort.env.wasm.wasmPaths = { wasm: "/ort/ort-wasm-simd-threaded.wasm" };
    ort.env.wasm.numThreads = 1;
    const manifest = await (await fetch("/models/silueta.json")).json() as { sha256: string; size: number; parts: string[] };
    const parts = await Promise.all(manifest.parts.map((p) => fetchCached(`/models/${p}`)));
    const model = new Uint8Array(manifest.size);
    let off = 0;
    for (const p of parts) { model.set(new Uint8Array(p), off); off += p.byteLength; }
    if (await sha256Hex(model) !== manifest.sha256) {
      await caches.delete(CACHE).catch(() => {});
      throw new Error("Background model is corrupted - please retry");
    }
    return ort.InferenceSession.create(model, { executionProviders: ["wasm"] });
  })();
  sessionPromise.catch(() => { sessionPromise = null; });
  return sessionPromise;
}

/** Start downloading the model early (e.g. when the capture screen opens). */
export function warmUpBackgroundModel(): void {
  session().catch(() => {});
}

function canvas(w: number, h: number) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

/** 320x320 saliency mask of the main object, values 0..1. */
async function objectMask(bmp: ImageBitmap): Promise<Float32Array> {
  const c = canvas(SIZE, SIZE);
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0, SIZE, SIZE);
  const px = ctx.getImageData(0, 0, SIZE, SIZE).data;
  let max = 1;
  for (let i = 0; i < px.length; i += 4) max = Math.max(max, px[i], px[i + 1], px[i + 2]);
  const input = new Float32Array(3 * SIZE * SIZE);
  for (let i = 0, p = 0; p < SIZE * SIZE; i += 4, p++) {
    for (let ch = 0; ch < 3; ch++) input[ch * SIZE * SIZE + p] = (px[i + ch] / max - MEAN[ch]) / STD[ch];
  }
  const s = await session();
  const out = await s.run({ [s.inputNames[0]]: new ort.Tensor("float32", input, [1, 3, SIZE, SIZE]) });
  return normalizeMask(out[s.outputNames[0]].data as Float32Array);
}

export interface WhiteResult { main: Blob; thumb: Blob; width: number; height: number }

/**
 * Put the item on a clean white background and centre it with a margin.
 * Returns null when the model can't find a clear single object (the original photo is kept).
 */
export async function whiteBackground(source: Blob, thumbEdge = 400): Promise<WhiteResult | null> {
  const bmp = await createImageBitmap(source, { imageOrientation: "from-image" });
  try {
    const mask = await objectMask(bmp);
    const box = maskBox(mask, SIZE, SIZE);
    if (!box || box.coverage < 0.02 || box.coverage > 0.95) return null;

    const W = bmp.width, H = bmp.height;
    // full-size soft mask
    const m = canvas(SIZE, SIZE);
    const mctx = m.getContext("2d")!;
    const mimg = mctx.createImageData(SIZE, SIZE);
    for (let i = 0; i < mask.length; i++) {
      const a = Math.round(alphaCurve(mask[i]) * 255);
      mimg.data[i * 4 + 3] = a;
    }
    mctx.putImageData(mimg, 0, 0);
    const full = canvas(W, H);
    const fctx = full.getContext("2d", { willReadFrequently: true })!;
    fctx.imageSmoothingQuality = "high";
    fctx.drawImage(m, 0, 0, W, H);
    const alpha = fctx.getImageData(0, 0, W, H).data;
    fctx.clearRect(0, 0, W, H);
    fctx.drawImage(bmp, 0, 0);
    const img = fctx.getImageData(0, 0, W, H);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const a = alpha[i + 3] / 255;
      d[i] = d[i] * a + 255 * (1 - a);
      d[i + 1] = d[i + 1] * a + 255 * (1 - a);
      d[i + 2] = d[i + 2] * a + 255 * (1 - a);
    }
    fctx.putImageData(img, 0, 0);

    // crop to the object with a 10% margin, on white
    const pad = 0.1;
    const bx = box.x * W, by = box.y * H, bw = box.w * W, bh = box.h * H;
    const side = Math.max(bw, bh) * (1 + 2 * pad);
    const outW = Math.round(Math.min(W, Math.max(bw * (1 + 2 * pad), side * 0.75)));
    const outH = Math.round(Math.min(H, Math.max(bh * (1 + 2 * pad), side * 0.75)));
    const out = canvas(outW, outH);
    const octx = out.getContext("2d")!;
    octx.fillStyle = "#fff";
    octx.fillRect(0, 0, outW, outH);
    octx.drawImage(full, bx + bw / 2 - outW / 2, by + bh / 2 - outH / 2, outW, outH, 0, 0, outW, outH);

    const toJpeg = (c: HTMLCanvasElement, q: number) => new Promise<Blob>((res, rej) =>
      c.toBlob((b) => (b ? res(b) : rej(new Error("encode failed"))), "image/jpeg", q));
    const scale = Math.min(1, thumbEdge / Math.max(outW, outH));
    const t = canvas(Math.round(outW * scale), Math.round(outH * scale));
    t.getContext("2d")!.drawImage(out, 0, 0, t.width, t.height);
    return { main: await toJpeg(out, 0.88), thumb: await toJpeg(t, 0.7), width: outW, height: outH };
  } finally {
    bmp.close();
  }
}
