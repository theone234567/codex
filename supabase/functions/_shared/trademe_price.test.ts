import { describe, expect, it } from "vitest";
import { priceOf, relevance, searchTerms, summarise } from "./trademe_price";

describe("Trade Me price check", () => {
  it("picks search words from the title", () => {
    expect(searchTerms("Shrek 2 DVD - Region 4, Used, Good condition")).toEqual(["shrek", "dvd", "region"]);
  });
  it("uses bid, then buy now, then start price", () => {
    expect(priceOf({ BidCount: 3, MaxBidAmount: 12, StartPrice: 1 })).toBe(12);
    expect(priceOf({ HasBuyNow: true, BuyNowPrice: 20, StartPrice: 5 })).toBe(20);
    expect(priceOf({ StartPrice: 5 })).toBe(5);
    expect(priceOf({ PriceDisplay: "$7.50" })).toBe(7.5);
    expect(priceOf({})).toBeNull();
  });
  it("ignores unrelated and classified listings", () => {
    const terms = ["shrek", "dvd"];
    expect(relevance({ Title: "Shrek 2 DVD" }, terms)).toBe(1);
    expect(relevance({ Title: "Toy Story DVD" }, terms)).toBe(0.5);
    const r = summarise([
      { Title: "Shrek DVD", StartPrice: 4 }, { Title: "Shrek 2 dvd", StartPrice: 6 }, { Title: "Shrek DVD R4", StartPrice: 8 },
      { Title: "Toy Story DVD", StartPrice: 90 }, { Title: "Shrek DVD", StartPrice: 500, IsClassified: true },
    ], terms);
    expect(r.found).toBe(true);
    expect(r.typical).toBe(6);
    expect(r.start).toBe(3.5);
    expect(r.buy_now).toBe(6);
    expect(r.summary).toContain("3 similar");
    expect(r.sources[0].url).toBe("https://www.trademe.co.nz/a/search?search_string=shrek%20dvd");
  });
  it("says so when there is too little to compare", () => {
    expect(summarise([{ Title: "Shrek DVD", StartPrice: 4 }], ["shrek", "dvd"]).found).toBe(false);
  });
});
