import { FunctionsHttpError } from "@supabase/supabase-js";
import { supabase } from "./supabase";
import { aiImageBase64, readBarcode, type Processed } from "./image";
import type { Batch, Item, Photo } from "./types";

const BUCKET = "photos";
export const AI_PHOTOS_PER_ITEM = 2; // front + back is usually enough; each extra photo ~600 tokens

function check<T>(res: { data: T; error: { message: string } | null }): NonNullable<T> {
  if (res.error) throw new Error(res.error.message);
  if (res.data === null || res.data === undefined) throw new Error("Not found");
  return res.data as NonNullable<T>;
}

function ok(res: { error: { message: string } | null }): void {
  if (res.error) throw new Error(res.error.message);
}

export const thumbPath = (p: string) => p.replace(/\.jpg$/, "_t.jpg");

// ---------- batches ----------
export async function listBatches(): Promise<(Batch & { items: { count: number }[] })[]> {
  return check(await supabase.from("batches").select("id,name,created_at,items(count)").order("created_at", { ascending: false }));
}

export async function createBatch(name: string): Promise<Batch> {
  return check(await supabase.from("batches").insert({ name: name.trim().slice(0, 80) || "New batch" }).select().single());
}

export async function deleteBatch(id: string): Promise<void> {
  const photos = check(await supabase.from("photos").select("storage_path, items!inner(batch_id)").eq("items.batch_id", id));
  await removeFiles(photos.map((p) => p.storage_path));
  ok(await supabase.from("batches").delete().eq("id", id));
}

// ---------- items ----------
export async function listItems(batchId: string): Promise<Item[]> {
  const rows = check(await supabase.from("items").select("*, photos(*)").eq("batch_id", batchId)
    .order("position").order("position", { referencedTable: "photos" }));
  return rows as Item[];
}

export async function getItem(id: string): Promise<Item> {
  return check(await supabase.from("items").select("*, photos(*)").eq("id", id)
    .order("position", { referencedTable: "photos" }).single()) as Item;
}

export async function createItem(batchId: string, position: number): Promise<Item> {
  const row = check(await supabase.from("items").insert({ batch_id: batchId, position }).select().single());
  return { ...(row as Item), photos: [] };
}

type EditableItem = Partial<Omit<Item, "id" | "batch_id" | "photos" | "ai_status" | "ai_error" | "ai_updated_at">>;
export async function updateItem(id: string, patch: EditableItem & { ai_status?: "pending" | "skipped" }): Promise<void> {
  ok(await supabase.from("items").update(patch).eq("id", id));
}

export async function deleteItem(item: Item): Promise<void> {
  await removeFiles(item.photos.map((p) => p.storage_path));
  ok(await supabase.from("items").delete().eq("id", item.id));
}

/** Move all photos of `item` onto `target` (fixes grouping mistakes), then delete `item`. */
export async function mergeInto(target: Item, item: Item): Promise<void> {
  let pos = target.photos.length;
  for (const p of item.photos) {
    ok(await supabase.from("photos").update({ item_id: target.id, position: pos++, crop: null }).eq("id", p.id));
  }
  ok(await supabase.from("items").delete().eq("id", item.id));
  await updateItem(target.id, { ai_status: "pending" });
}

// ---------- photos ----------
const blobCache = new Map<string, Blob>();

export async function addPhoto(userId: string, item: Item, processed: Processed, position: number): Promise<Photo> {
  const id = crypto.randomUUID();
  const path = `${userId}/${item.id}/${id}.jpg`;
  const opts = { contentType: "image/jpeg", upsert: false, cacheControl: "31536000" };
  await retry(async () => check(await supabase.storage.from(BUCKET).upload(path, processed.main, opts)));
  await retry(async () => check(await supabase.storage.from(BUCKET).upload(thumbPath(path), processed.thumb, opts)));
  blobCache.set(path, processed.main);
  return check(await supabase.from("photos").insert({
    id, item_id: item.id, storage_path: path, position, width: processed.width, height: processed.height,
  }).select().single()) as Photo;
}

export async function updatePhoto(id: string, patch: Partial<Pick<Photo, "rotation" | "crop" | "position">>): Promise<void> {
  ok(await supabase.from("photos").update(patch).eq("id", id));
}

export async function deletePhoto(photo: Photo): Promise<void> {
  await removeFiles([photo.storage_path]);
  ok(await supabase.from("photos").delete().eq("id", photo.id));
}

async function removeFiles(paths: string[]): Promise<void> {
  const all = paths.flatMap((p) => [p, thumbPath(p)]);
  for (let i = 0; i < all.length; i += 100) {
    await supabase.storage.from(BUCKET).remove(all.slice(i, i + 100));
  }
}

export async function downloadPhoto(path: string): Promise<Blob> {
  const cached = blobCache.get(path);
  if (cached) return cached;
  const blob = check(await supabase.storage.from(BUCKET).download(path)) as Blob;
  blobCache.set(path, blob);
  return blob;
}

const urlCache = new Map<string, { url: string; expires: number }>();
/** Short-lived signed URLs: photos are never public. */
export async function signedUrls(paths: string[]): Promise<Record<string, string>> {
  const now = Date.now();
  const out: Record<string, string> = {};
  const missing = paths.filter((p) => {
    const c = urlCache.get(p);
    if (c && c.expires > now + 60_000) { out[p] = c.url; return false; }
    return true;
  });
  for (let i = 0; i < missing.length; i += 100) {
    const data = check(await supabase.storage.from(BUCKET).createSignedUrls(missing.slice(i, i + 100), 3600));
    for (const d of data) {
      if (d.signedUrl && d.path) {
        urlCache.set(d.path, { url: d.signedUrl, expires: now + 3600_000 });
        out[d.path] = d.signedUrl;
      }
    }
  }
  return out;
}

// ---------- AI ----------
export async function analyzeItem(item: Item): Promise<void> {
  const photos = item.photos.slice(0, AI_PHOTOS_PER_ITEM);
  if (!photos.length) throw new Error("Add a photo first");
  const blobs = await Promise.all(photos.map((p) => downloadPhoto(p.storage_path)));
  let barcode = item.barcode;
  if (!barcode) {
    for (const b of blobs) {
      barcode = await readBarcode(b);
      if (barcode) break;
    }
    if (barcode) await updateItem(item.id, { barcode });
  }
  const images = await Promise.all(blobs.map(aiImageBase64));
  const { error } = await supabase.functions.invoke("analyze-item", {
    body: { itemId: item.id, images, hint: item.hint.slice(0, 300), barcode },
  });
  if (error) {
    let msg = "AI request failed";
    if (error instanceof FunctionsHttpError) {
      try { msg = (await error.context.json()).error ?? msg; } catch { /* keep default */ }
    }
    throw new Error(msg);
  }
}

export async function usageToday(): Promise<{ calls: number; input_tokens: number; output_tokens: number } | null> {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Pacific/Auckland" }).format(new Date());
  const { data } = await supabase.from("ai_usage").select("calls,input_tokens,output_tokens")
    .eq("day", today).maybeSingle();
  return data;
}

async function retry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= tries - 1) throw e;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
    }
  }
}
