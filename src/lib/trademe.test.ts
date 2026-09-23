import { describe, expect, it } from "vitest";
import { boolLike, buildTradeMeCsv, fieldFor, parseCsv, skuFor, templateFromCsv, tmCell } from "./trademe";
import type { Item } from "./types";

const item = (over: Partial<Item> = {}): Item => ({
  id: "3b241101-e2bb-4255-8caf-4136c566a962", batch_id: "b", position: 0, status: "ready", ai_status: "done",
  ai_error: null, ai_updated_at: null, hint: "", barcode: "", title: 'Shrek 2 "Special" DVD', subtitle: "",
  description: "- Plays fine\n- Case ok", category_path: "Movies & TV > DVDs", condition: "Used",
  attributes: [{ name: "Region", value: "4" }], start_price: 3, buy_now_price: 6, price_confidence: "medium",
  price_reasoning: "", shipping_size: "Small parcel", weight_kg: 0.2, needs_check: [], tm_category: "",
  price_check: null, price_checked_at: null, exported_at: null, photos: [], ...over,
});

describe("csv parsing", () => {
  it("handles quotes, commas and newlines", () => {
    expect(parseCsv('a,b\r\n"x, y","he said ""hi""\nbye"\n')).toEqual([["a", "b"], ["x, y", 'he said "hi"\nbye']]);
  });
});

describe("template", () => {
  const csv = 'SKU,Title,Description,Category,Start_Price,Is_New,Duration,Pickup,Photo_ID_List,Listing_ID\n'
    + 'OLD1,Old thing,Old desc,0003-0050-,5,No,7,Allow,a.jpg,12345\n';
  it("keeps option defaults but never copies another product's content", () => {
    const t = templateFromCsv(csv);
    expect(t.headers).toHaveLength(10);
    expect(t.defaults).toEqual(["", "", "", "0003-0050-", "", "No", "7", "Allow", "", ""]);
  });
  it("rejects files that aren't product exports", () => {
    expect(() => templateFromCsv("foo,bar\n1,2")).toThrow();
  });
  it("builds rows in the template's column order and styles", () => {
    const t = templateFromCsv(csv);
    const out = parseCsv(buildTradeMeCsv([item()], t, new Map([[item().id, ["https://x/1.jpg", "https://x/2.jpg"]]]), {}));
    expect(out[0]).toEqual(t.headers);
    const row = Object.fromEntries(t.headers.map((h, i) => [h, out[1][i]]));
    expect(row.SKU).toBe(skuFor(item()));
    expect(row.Title).toBe('Shrek 2 "Special" DVD');
    expect(row.Description).toBe("- Plays fine\n- Case ok\n\nRegion: 4");
    expect(row.Category).toBe("0003-0050-");
    expect(row.Start_Price).toBe("3.00");
    expect(row.Is_New).toBe("No");
    expect(row.Duration).toBe("7");
    expect(row.Photo_ID_List).toBe("https://x/1.jpg;https://x/2.jpg");
    expect(row.Listing_ID).toBe("");
  });
  it("prefers the item's own category code, then remembered codes", () => {
    const t = templateFromCsv(csv);
    const cat = (it: Item, map: Record<string, string>) => parseCsv(buildTradeMeCsv([it], t, new Map(), map))[1][3];
    expect(cat(item(), { "Movies & TV > DVDs": "0003-9999-" })).toBe("0003-9999-");
    expect(cat(item({ tm_category: "1234" }), { "Movies & TV > DVDs": "0003-9999-" })).toBe("1234");
  });
});

describe("helpers", () => {
  it("maps header aliases", () => {
    expect(fieldFor("Buy Now Price")).toBe("buynow");
    expect(fieldFor("photo_id_list")).toBe("photos");
    expect(fieldFor("Payment methods")).toBeNull();
  });
  it("mirrors boolean style", () => {
    expect(boolLike("No", true)).toBe("Yes");
    expect(boolLike("FALSE", true)).toBe("TRUE");
    expect(boolLike("0", false)).toBe("0");
    expect(boolLike("", true)).toBe("true");
  });
  it("defuses formulas but keeps bullet points", () => {
    expect(tmCell("=cmd()")).toBe(`"'=cmd()"`);
    expect(tmCell("- bullet")).toBe(`"- bullet"`);
    expect(tmCell("-1+1")).toBe(`"'-1+1"`);
  });
  it("makes stable SKUs", () => {
    expect(skuFor({ id: "3b241101-e2bb-4255-8caf-4136c566a962" })).toBe("KL3B241101E2");
  });
});
