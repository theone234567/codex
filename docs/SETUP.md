# Setting up klickList

Allow about 30 minutes. You need free accounts with **Supabase**, **Anthropic** and **Cloudflare**. **Resend** (for email) and **Twilio** (for text messages) are optional.

## 1. Supabase (sign-in, database, photos)

1. Go to <https://supabase.com> → **New project**. Choose the **Sydney** region because it's closest to NZ, and save the database password somewhere safe.
2. Install the Supabase CLI (<https://supabase.com/docs/guides/cli>), then in this folder run:
   ```bash
   supabase login
   supabase link --project-ref YOUR-PROJECT-REF   # Project Settings → General
   supabase db push                               # creates tables, security rules, photo bucket
   ```
3. **Authentication → Sign In / Providers**:
   - Turn **off** "Allow new users to sign up". This keeps the app private.
   - Make sure **Email** is enabled.
   - Optional (costs about NZ$0.15 per text): enable **Phone**, enter your Twilio details, set `VITE_ENABLE_PHONE=true` in step 3, and in the Twilio console under *Messaging → Geo permissions* allow **New Zealand only**. This blocks SMS-fraud charges.
4. Sign-in emails contain a **sign-in link** by default, and klickList accepts that. Optionally, once you've added your own SMTP (next step), edit **Authentication → Emails → Magic link or OTP** to include `{{ .Token }}` so the email also shows a 6-digit code. Codes work better inside an installed home-screen app, because links open in the normal browser.
5. **Authentication → Emails → SMTP Settings**: add an SMTP provider. Resend is free for 3,000 emails a month. Supabase's built-in email only sends a few messages an hour and is meant for testing.
6. **Authentication → Users → Add user**: create yourself with your email and/or mobile number (+64…) and tick "Auto confirm".
7. **Project Settings → API**: copy the **Project URL** and the **anon public** key for step 3.
   Never put the `service_role` key anywhere in the website.

## 2. AI and price-check keys

You need **at least one** AI key. Having both lets each back up the other.

**Claude (best listings, about US$0.07 per 50 items in economy mode)**
1. Sign up at <https://console.anthropic.com>. This is separate from a Claude.ai subscription: the API is pay-as-you-go.
2. Add US$5 of credit, which covers several thousand listings. Under **Limits**, set a monthly spend limit such as US$10.
3. Create an API key.

**Gemini (free)**
1. Go to <https://aistudio.google.com>, sign in with a Google account, and click **Get API key**. No card is needed for the free tier.
2. The free tier has daily limits that Google adjusts, roughly 500–1,000 requests a day for Flash-Lite. AI Studio shows your current limits.
3. On the free tier, Google may use what you send (photos and notes) to improve its products. Use Claude if that matters to you.

**Trade Me API (free price checks)**
1. Sign in to Trade Me and register an application in the developer area (see <https://developer.trademe.co.nz>). Ask for **read-only** access; klickList only searches listings.
2. You receive a **consumer key** and **consumer secret**. New apps may start on Trade Me's sandbox (`tmsandbox.co.nz`) until Trade Me approves production access. Set `TRADEME_SANDBOX=true` while you're on the sandbox.
3. Until this is set up, price checks use a Claude web search instead (about 2c each), or you can turn them off in Settings.

**Save the keys on the server and deploy:**
```bash
supabase secrets set \
  ANTHROPIC_API_KEY=sk-ant-... \
  GEMINI_API_KEY=... \
  TRADEME_CONSUMER_KEY=... TRADEME_CONSUMER_SECRET=... \
  ALLOWED_ORIGINS=https://klicklist.pages.dev \
  ALLOWED_USERS=you@example.com \
  AI_DAILY_LIMIT=150
# optional:
#   AI_MODEL=claude-sonnet-5|claude-opus-5   better but pricier (default claude-haiku-4-5)
#   GEMINI_MODEL=...                          default gemini-3.1-flash-lite
#   PRICE_SOURCES=trademe,claude              fall back to a paid web search when Trade Me finds nothing
supabase functions deploy analyze-item
supabase functions deploy ai-batch
supabase functions deploy price-check
```
- `ALLOWED_ORIGINS` is your website address from step 3. You can come back and set it afterwards.
- `ALLOWED_USERS` is optional but recommended. It's a list of the emails that may use the AI.

In the app, **Settings → Which AI** chooses Claude or Gemini, whether the other one is used as a backup, and economy mode.

## 3. Cloudflare Pages (the website)

1. Go to <https://dash.cloudflare.com> → **Workers & Pages → Create → Pages → Connect to Git** and choose this repository.
2. Set the build command to `npm run build` and the output folder to `dist`.
3. Under **Environment variables**, add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` (from step 1.7).
4. Deploy. You get an address like `https://klicklist.pages.dev`.
5. Back in Supabase, go to **Authentication → URL Configuration**, set **Site URL** to that address, and add it under **Redirect URLs** too, so sign-in links return to your site. Update `ALLOWED_ORIGINS` if you haven't already, then run `supabase functions deploy analyze-item ai-batch price-check` again.

Netlify works the same way. `public/_headers` sets the security headers on both. If you use a custom domain for Supabase, add it to `connect-src` and `img-src` in `public/_headers`.

## 4. Trade Me import template (one time, on a computer)

1. On Trade Me, open **My Products** (<https://sell.trademe.co.nz>) and create one product by hand with your usual listing duration, pickup, shipping and payment options.
2. Export your products to CSV.
3. In klickList, go to **Settings → Trade Me import template** and load that CSV.

klickList then writes files with Trade Me's exact columns and uses that product's options as defaults for every export.

## 5. On your phone and computer

The same website and account work on both. Sign in with your email code on each device.

Open the site → **Share → Add to Home Screen** (iPhone) or **⋮ → Install app** (Android). Allow camera access when asked.

## Everyday use

1. **New batch**, then snap items on your phone: 1–3 photos each, then **Next item**. Photo 1 should be the front and photo 2 the back or label. On a computer you can drag & drop photos instead.
2. Tap **Done**. The AI writes all the listings. In economy mode they arrive within minutes to an hour, and you can close the app while you wait. White backgrounds and price checks run while the batch page is open. A computer does white backgrounds fastest, so it's a good idea to open the batch on your desktop.
3. **Review & approve**: check each draft, fix anything flagged, then **Approve & next** (Ctrl/Cmd+Enter on desktop).
4. **Upload to Trade Me**: create the file, then on Trade Me go to **My Products → Import photos & products → Import CSV file**.
5. When items sell, delete old batches to free up storage.
