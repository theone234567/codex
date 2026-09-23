// Trade Me "My Products" CSV import file.
// Trade Me requires every column of its template to be present. The safest way to get the exact
// columns is to load a CSV exported from your own My Products page once ("template"); its first
// product row also supplies your usual defaults (duration, pickup, shipping, payment...).
import { fullDescription } from "./csv";
import type { Item, TmTemplate } from "./types";

/** Used only until a real template is loaded. Names follow Trade Me's import guide where known. */
export const FALLBACK_HEADERS = [
  "sku", "title", "subtitle", "description", "category", "start_price", "reserve_price",
  "buy_now_price", "is_new", "photo_id_list",
];

type Field = "sku" | "title" | "subtitle" | "description" | "category" | "start" | "reserve" | "buynow" | "isnew" | "photos" | "quantity";

const ALIASES: Record<Field, string[]> = {
  sku: ["sku", "productcode", "productsku", "code"],
  title: ["title", "listingtitle", "name", "productname"],
  subtitle: ["subtitle", "listingsubtitle"],
  description: ["description", "body", "details", "listingdescription"],
  category: ["category", "categoryid", "categorynumber", "categorycode", "tradmecategory", "trademecategory"],
  start: ["startprice", "startingprice", "auctionstartprice", "start"],
  reserve: ["reserveprice", "reserve"],
  buynow: ["buynowprice", "buynow", "fixedprice", "price"],
  isnew: ["isnew", "isbrandnew", "brandnew", "new", "isitemnew"],
  photos: ["photoidlist", "photoids", "photos", "photo", "images", "imagelist", "photourls"],
  quantity: ["quantity", "qty", "stock", "stocklevel"],
};

const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, "");

export function fieldFor(header: string): Field | null {
  const n = norm(header);
  for (const [field, names] of Object.entries(ALIASES) as [Field, string[]][]) {
    if (names.includes(n)) return field;
  }
  return null;
}

export function skuFor(item: Pick<Item, "id">): string {
  return "KL" + item.id.replace(/-/g, "").slice(0, 10).toUpperCase();
}

/** Minimal RFC 4180 CSV parser (quotes, escaped quotes, newlines inside quotes). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", q = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"' && s[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

export function templateFromCsv(text: string): TmTemplate {
  const rows = parseCsv(text);
  if (!rows.length) throw new Error("That file is empty");
  const headers = rows[0].map((h) => h.trim()).slice(0, 200);
  if (headers.length < 3 || !headers.some((h) => fieldFor(h) === "title")) {
    throw new Error("That doesn't look like a Trade Me My Products export (no title column)");
  }
  const defaults = headers.map((_, i) => (rows[1]?.[i] ?? "").slice(0, 2000));
  // Never copy one product's identity/content into every new product.
  headers.forEach((h, i) => {
    const f = fieldFor(h);
    if (f && f !== "category" && f !== "isnew" && f !== "quantity") defaults[i] = "";
    if (/listingid|productid|^id$/i.test(norm(h))) defaults[i] = "";
  });
  return { headers, defaults, loadedAt: new Date().toISOString() };
}

/** Write booleans in the same style as the template (true/false, yes/no, y/n, 1/0). */
export function boolLike(sample: string, value: boolean): string {
  const s = sample.trim();
  const styles: [string, string][] = [["true", "false"], ["yes", "no"], ["y", "n"], ["1", "0"]];
  for (const [t, f] of styles) {
    if (s.toLowerCase() === t || s.toLowerCase() === f) {
      const out = value ? t : f;
      return s === s.toUpperCase() ? out.toUpperCase() : s[0] === s[0].toUpperCase() ? out[0].toUpperCase() + out.slice(1) : out;
    }
  }
  return value ? "true" : "false";
}

/** CSV cell for Trade Me. Formula characters are defused, but "- " bullet points are kept. */
export function tmCell(value: string): string {
  let s = value;
  if (/^[=+@\t\r]/.test(s) || /^-[^\s]/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
}

const price = (n: number | null) => (n === null || n === undefined ? "" : Number(n).toFixed(2));

export function buildTradeMeCsv(
  items: Item[],
  template: TmTemplate | null,
  photoLists: Map<string, string[]>,
  categoryMap: Record<string, string>,
): string {
  const headers = template?.headers ?? FALLBACK_HEADERS;
  const defaults = template?.defaults ?? headers.map(() => "");
  const lines = [headers.map(tmCell).join(",")];
  for (const item of items) {
    const row = headers.map((h, i) => {
      const d = defaults[i] ?? "";
      switch (fieldFor(h)) {
        case "sku": return skuFor(item);
        case "title": return item.title;
        case "subtitle": return item.subtitle;
        case "description": return fullDescription(item);
        case "category": return item.tm_category || categoryMap[item.category_path] || d;
        case "start": return price(item.start_price);
        case "reserve": return price(item.start_price);
        case "buynow": return price(item.buy_now_price);
        case "isnew": return boolLike(d, item.condition === "New");
        case "photos": return (photoLists.get(item.id) ?? []).join(";");
        case "quantity": return d || "1";
        default: return d;
      }
    });
    lines.push(row.map(tmCell).join(","));
  }
  return lines.join("\r\n");
}
