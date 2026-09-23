# klickList

Photograph a pile of things you want to sell, and AI writes the Trade Me listings for you.

1. **Snap.** Take 1–3 photos of an item and tap **Next item**. Do that for all 50 items. You can also bulk-import photos from your gallery.
2. **AI writes.** For each item it writes the title, description, category, condition, suggested start and Buy Now prices, DVD/Blu-ray region, brand and other details. It also flags anything you should check.
3. **Tidy.** Photos are automatically turned the right way up, colour-corrected, resized and compressed on your phone, so this costs nothing. The AI also suggests a crop.
4. **List fast.** Quick-list mode shows one item at a time with copy buttons for each field and a button to save or share the photos. Then tap **Mark listed & next**. You can also export everything to CSV.

It runs in the browser and can be installed on your phone like an app (**Add to Home Screen**).

## Cost (kept as low as possible)

| Part | Service | Cost |
|---|---|---|
| Website | Cloudflare Pages (or Netlify) | Free |
| Sign-in, database, photo storage | Supabase free tier | Free (1 GB storage is about 1,000+ items) |
| Email sign-in codes | Resend SMTP free tier | Free (3,000 emails a month) |
| Phone sign-in codes (optional) | Twilio | About NZ$0.15 per text, so use email for everyday sign-in |
| AI | Anthropic API | See below |

**AI tokens are kept to a minimum:**
- The AI sees small 768px copies of your photos (about 600 tokens each), never the full-size photos.
- Only the first 2 photos of each item are sent (front and back/label).
- The prompt and the answer format are short and fixed, with no extended thinking, low effort, and at most 1,200 output tokens.
- Barcodes are read on your phone for free and sent as text, which helps the AI identify DVDs and books without sending extra photos.
- Each item goes to the AI **once**. It only runs again if you tap **Re-write with AI**.
- Every account has a daily cap (`AI_DAILY_LIMIT`, 150 items by default).

Rough AI cost for 50 items:
- About US$1 on the default model (`claude-opus-5`).
- About US$0.20 if you set `AI_MODEL=claude-haiku-4-5`, which is roughly 5× cheaper, with slightly less polished writing and pricing.

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
  - The AI has no tools and can't take any action. You review every listing before it goes on Trade Me.
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
supabase/functions/analyze-item/   the only place the AI key is used
supabase/functions/_shared/  prompt, answer schema, validation and cleaning
```
