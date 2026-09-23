// Pure maths for the free, on-device photo tidy-up (no AI tokens used).

/** Value at the given percentile (0-1) of a 256-bin histogram. */
export function percentile(hist: ArrayLike<number>, total: number, p: number): number {
  const target = total * p;
  let acc = 0;
  for (let i = 0; i < 256; i++) {
    acc += hist[i];
    if (acc >= target) return i;
  }
  return 255;
}

/**
 * Auto-levels per channel (also neutralises colour casts, i.e. a simple white balance).
 * `strength` blends between the original (0) and a full stretch (1) so results stay natural.
 */
export function levelsLut(hist: ArrayLike<number>, total: number, strength = 0.6): Uint8Array {
  const lo = percentile(hist, total, 0.005);
  const hi = percentile(hist, total, 0.995);
  const lut = new Uint8Array(256);
  const range = hi - lo;
  for (let i = 0; i < 256; i++) {
    if (range < 32) { lut[i] = i; continue; } // flat/odd image: leave alone
    const stretched = ((i - lo) / range) * 255;
    const v = i + (stretched - i) * strength;
    lut[i] = Math.max(0, Math.min(255, Math.round(v)));
  }
  return lut;
}

/** Size that fits inside maxEdge while keeping aspect ratio (never upscales). */
export function fitWithin(w: number, h: number, maxEdge: number): { w: number; h: number } {
  const scale = Math.min(1, maxEdge / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
}

/** Pixel rectangle for a fractional crop, clamped to the image. */
export function cropRect(
  w: number, h: number, crop: { x: number; y: number; w: number; h: number } | null, pad = 0.03,
): { sx: number; sy: number; sw: number; sh: number } {
  if (!crop) return { sx: 0, sy: 0, sw: w, sh: h };
  const x0 = Math.max(0, crop.x - pad), y0 = Math.max(0, crop.y - pad);
  const x1 = Math.min(1, crop.x + crop.w + pad), y1 = Math.min(1, crop.y + crop.h + pad);
  return { sx: Math.round(x0 * w), sy: Math.round(y0 * h), sw: Math.round((x1 - x0) * w), sh: Math.round((y1 - y0) * h) };
}

/** Min-max normalise a saliency map to 0..1 (what rembg does with U2-Net output). */
export function normalizeMask(pred: Float32Array): Float32Array {
  let mi = Infinity, ma = -Infinity;
  for (const v of pred) { if (v < mi) mi = v; if (v > ma) ma = v; }
  const out = new Float32Array(pred.length);
  const range = ma - mi || 1;
  for (let i = 0; i < pred.length; i++) out[i] = (pred[i] - mi) / range;
  return out;
}

/** Sharpen soft mask edges a little so the background goes properly white. */
export function alphaCurve(a: number): number {
  return Math.min(1, Math.max(0, (a - 0.12) / 0.7));
}

/** Bounding box (fractions) of mask pixels above threshold, plus the share of the image covered. */
export function maskBox(mask: Float32Array, w: number, h: number, threshold = 0.5):
  { x: number; y: number; w: number; h: number; coverage: number } | null {
  let x0 = w, y0 = h, x1 = -1, y1 = -1, n = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x] > threshold) {
        n++;
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  if (!n) return null;
  return { x: x0 / w, y: y0 / h, w: (x1 - x0 + 1) / w, h: (y1 - y0 + 1) / h, coverage: n / (w * h) };
}
