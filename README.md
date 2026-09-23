# klickList

Photograph a pile of things you want to sell, and AI writes the Trade Me listings for you. Works on **phone and desktop** with the same account: shoot on your phone, then review and upload on your computer.

1. **Snap.** Take 1–3 photos of an item and tap **Next item**. Do that for all 50 items. You can also bulk-import or drag & drop photos on a computer. Desktop shortcuts: Space = photo, N = next item.
2. **AI writes.** For each item it writes the title, description, category, condition, suggested start and Buy Now prices, DVD/Blu-ray region, brand and other details. It also flags anything you should check.
3. **Tidy photos (free).** Photos are automatically turned the right way up, colour-corrected and compressed. **White backgrounds** are made on your own device using a free model, so there's no AI cost.
4. **Price check online (very cheap).** One web search per item on the cheapest AI, only for items worth checking (default $15 and up).
5. **Review & approve.** Go through the drafts one by one, edit anything, and tap **Approve & next**. On desktop, Ctrl/Cmd+Enter does the same.
6. **Upload to Trade Me.** Approved items become a Trade Me **My Products** import file. Photos are included as links, or as a ZIP of photo files. Import it on Trade Me, check, and list. Re-exporting updates the same products instead of creating duplicates.

You can also use copy-paste mode (one item at a time, with copy buttons for each field) and CSV export.

## Pricing

Running costs are free except the AI, which you pay Anthropic for by usage (USD, rough estimates):

| What | Per item | 50 items |
|---|---|---|
| Listing writing, Claude Haiku 4.5 (`AI_MODEL=claude-haiku-4-5`, cheapest) | ~0.4c | ~$0.20 |
| Listing writing, Claude Sonnet 5 (`AI_MODEL=claude-sonnet-5`) | ~0.8c | ~$0.40 |
| Listing writing, Claude Opus 5 (default, best writing and pricing) | ~2c | ~$1.00 |
| Online price check (Haiku 4.5, 1 web search) | ~1.5–2c | only items ≥ $15, so typically ~$0.20 |
| White backgrounds, photo tidy, barcodes | free (on your device) | free |
| Website, database, photo storage, email sign-in codes | free tiers | free |
| Phone text sign-in codes (optional) | ~NZ$0.15 per text | — |

**AI tokens are kept to a minimum:**
- The AI sees small 768px copies of the first 2 photos only, about 600 tokens each.
- Short fixed prompt, no extended thinking, low effort, and answers capped at 1,200 tokens.
- Price checks send text only (no photos), do 1 web search, and are capped at 700 tokens.
- Barcodes are read free on your device.
- Each item goes to the AI once. It only runs again if you tap **Re-write with AI** or **Check price**.
- There's a daily cap per account (`AI_DAILY_LIMIT`, default 150), plus a monthly spend limit set in your Anthropic account.

## Security

- **Sign-in:** a 6-digit code sent by email or text. There are no passwords to leak. New sign-ups are turned off, so only accounts you create can sign in. `ALLOWED_USERS` adds a second allowlist check on the server.
- **Your data:** Postgres Row Level Security means each user can only ever read or change their own batches, items, photos and usage. This is enforced in the database, not only in the app, and there is an automated test for it (`supabase/tests/rls_check.sql`, run in CI). Photos are stored in a private bucket and shown through links that expire after 1 hour.
- **Protecting the AI from misuse:**
  - The Anthropic key is only stored as a server secret and is never sent to the browser.
  - The AI endpoint only accepts signed-in, allowlisted users from your own website.
  - It only accepts 1–3 small JPEGs, a note of up to 300 characters and a barcode, and checks every field.
  - The prompt, the model and the answer format are fixed on the server, so it can't be used as a general chatbot.
  - Text in photos or notes (for example "ignore your instructions") is treated as information about the item, never as a command.
  - The AI can only answer in a fixed JSON shape. That answer is checked again and cleaned (HTML removed, lengths and prices limited) before it is saved.
  - The listing AI has no tools. The price-check AI can only do 1 web search and must answer through a fixed form. Numbers are checked and limited, and only https links are kept.
  - Price checks never change an item you've already approved. Nothing goes to Trade Me until you approve it and import the file yourself.
  - The daily cap per user and an Anthropic spend limit put a ceiling on cost.
- **Website:** a strict Content-Security-Policy and other security headers (`public/_headers`), no third-party scripts, and CSV export that protects against formula injection.

## Setup

See **[docs/SETUP.md](docs/SETUP.md)**. It takes about 30 minutes and every step can be done through a web page.

## Development

```bash
npm install
cp .env.example .env.local   # fill in your Supabase URL + anon key
npm run dev                  # http://localhost:5173
npm test                     # unit tests
npm run typecheck
```

```
src/                         React web app (Vite + TypeScript)
  pages/                     Login, Batches, Capture, BatchView, ItemEditor, QuickList
  lib/image.ts               on-device photo tidy-up, AI thumbnails, barcode reading
supabase/migrations/         database tables, security rules, private photo bucket
supabase/functions/analyze-item/   writes listings (the AI key is only used server-side)
supabase/functions/price-check/    one-search online price check
supabase/functions/_shared/  prompts, answer schemas, validation, sign-in/quota checks
src/lib/bgremove.ts          on-device white backgrounds (U2-Net "silueta", Apache-2.0)
src/lib/trademe.ts           Trade Me My Products CSV import file
```
