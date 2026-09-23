// Free price check from Trade Me's own API: search current listings for similar items and
// summarise their prices. No AI involved, so it costs nothing.
import type { PriceCheck } from "./price.ts";

export interface TmListing {
  ListingId?: number;
  Title?: string;
  StartPrice?: number;
  BuyNowPrice?: number;
  MaxBidAmount?: number;
  BidCount?: number;
  HasBuyNow?: boolean;
  PriceDisplay?: string;
  IsClassified?: boolean;
}

const STOP = new Set([
  "the", "and", "with", "for", "of", "in", "on", "a", "an", "to", "by", "from", "set", "used", "new", "good",
  "great", "condition", "vintage", "genuine", "original", "nz", "sale", "item", "size", "brand",
]);

export function tokens(text: string): string[] {
  return text.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/).filter((w) => w.length >= 2 && !STOP.has(w));
}

/** Search words: the most important words of the title (titles put them first). */
export function searchTerms(title: string, max = 6): string[] {
  return [...new Set(tokens(title))].slice(0, max);
}

/** Best current price signal for a listing: winning bid, else Buy Now, else start price. */
export function priceOf(l: TmListing): number | null {
  const pick = (l.BidCount ?? 0) > 0 && l.MaxBidAmount ? l.MaxBidAmount
    : l.HasBuyNow && l.BuyNowPrice ? l.BuyNowPrice
    : l.StartPrice ?? (l.PriceDisplay ? Number(l.PriceDisplay.replace(/[^0-9.]/g, "")) : NaN);
  return Number.isFinite(pick) && pick! > 0 && pick! < 100_000 ? pick! : null;
}

/** Share of the search words that appear in the listing title. */
export function relevance(l: TmListing, terms: string[]): number {
  if (!terms.length) return 0;
  const have = new Set(tokens(l.Title ?? ""));
  return terms.filter((t) => have.has(t)).length / terms.length;
}

function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

const round = (n: number) => (n < 10 ? Math.round(n * 2) / 2 : Math.round(n)); // $0.50 steps under $10

export function searchUrl(terms: string[]): string {
  return `https://www.trademe.co.nz/a/search?search_string=${encodeURIComponent(terms.join(" "))}`;
}

/** Turn search results into a price check. Asking prices run high, so start lower to attract bids. */
export function summarise(list: TmListing[], terms: string[]): PriceCheck {
  const matches = list
    .filter((l) => !l.IsClassified && relevance(l, terms) >= 0.6)
    .map((l) => priceOf(l))
    .filter((p): p is number => p !== null)
    .sort((a, b) => a - b);
  const sources = [{ url: searchUrl(terms), title: "Similar listings on Trade Me" }];
  if (matches.length < 2) {
    return { found: false, low: null, high: null, typical: null, start: 1, buy_now: null, summary: "Not enough similar Trade Me listings to compare", sources };
  }
  const low = round(quantile(matches, 0.1));
  const high = round(quantile(matches, 0.9));
  const typical = round(quantile(matches, 0.5));
  const start = Math.max(1, round(typical * 0.6));
  const buyNow = typical > start ? typical : null;
  return {
    found: true, low, high, typical, start, buy_now: buyNow,
    summary: `${matches.length} similar on Trade Me now, mostly $${low}-$${high}`,
    sources,
  };
}

/** Trade Me API search, signed as the app only (no member login) with OAuth 1.0 PLAINTEXT. */
export async function searchTradeMe(
  terms: string[], key: string, secret: string, sandbox: boolean, condition: string,
): Promise<TmListing[]> {
  const base = sandbox ? "https://api.tmsandbox.co.nz" : "https://api.trademe.co.nz";
  const params = new URLSearchParams({ search_string: terms.join(" "), rows: "50", return_metadata: "false" });
  if (condition === "New" || condition === "Used") params.set("condition", condition);
  const res = await fetch(`${base}/v1/Search/General.json?${params}`, {
    headers: {
      Authorization: `OAuth oauth_consumer_key="${key}", oauth_signature_method="PLAINTEXT", oauth_signature="${encodeURIComponent(secret)}&"`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Trade Me API ${res.status}`);
  const body = await res.json() as { List?: TmListing[] };
  return Array.isArray(body.List) ? body.List.slice(0, 100) : [];
}
