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
   - Optional: enable **Phone**, enter your Twilio details, and in the Twilio console under *Messaging → Geo permissions* allow **New Zealand only**. This blocks SMS-fraud charges.
4. **Authentication → Emails → Templates → Magic Link**: replace the body with something like
   `Your klickList code is {{ .Token }}`
   so people get a 6-digit code. Codes work better than links in a home-screen app.
5. **Authentication → Emails → SMTP Settings**: add an SMTP provider. Resend is free for 3,000 emails a month. Supabase's built-in email only sends a few messages an hour and is meant for testing.
6. **Authentication → Users → Add user**: create yourself with your email and/or mobile number (+64…) and tick "Auto confirm".
7. **Project Settings → API**: copy the **Project URL** and the **anon public** key for step 3.
   Never put the `service_role` key anywhere in the website.

## 2. Anthropic (the AI)

1. Go to <https://console.anthropic.com>, create an API key, and under **Limits** set a monthly spend limit (for example US$10).
2. Store the key as a Supabase secret and deploy the AI function:
   ```bash
   supabase secrets set \
     ANTHROPIC_API_KEY=sk-ant-... \
     ALLOWED_ORIGINS=https://klicklist.pages.dev \
     ALLOWED_USERS=you@example.com,+64211234567 \
     AI_DAILY_LIMIT=150
   # optional, about 5x cheaper per item:
   # supabase secrets set AI_MODEL=claude-haiku-4-5
   supabase functions deploy analyze-item
   ```
   - `ALLOWED_ORIGINS` is your website address from step 3. You can come back and set it afterwards.
   - `ALLOWED_USERS` is optional but recommended. It's a list of the emails and phone numbers that may use the AI.

## 3. Cloudflare Pages (the website)

1. Go to <https://dash.cloudflare.com> → **Workers & Pages → Create → Pages → Connect to Git** and choose this repository.
2. Set the build command to `npm run build` and the output folder to `dist`.
3. Under **Environment variables**, add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` (from step 1.7).
4. Deploy. You get an address like `https://klicklist.pages.dev`.
5. Back in Supabase, go to **Authentication → URL Configuration** and set **Site URL** to that address. Update `ALLOWED_ORIGINS` if you haven't already, then run `supabase functions deploy analyze-item` again.

Netlify works the same way. `public/_headers` sets the security headers on both. If you use a custom domain for Supabase, add it to `connect-src` and `img-src` in `public/_headers`.

## 4. On your phone

Open the site → **Share → Add to Home Screen** (iPhone) or **⋮ → Install app** (Android). Allow camera access when asked.

## Everyday use

1. **New batch**, then snap items: 1–3 photos each, then **Next item**. Photo 1 should be the front and photo 2 the back or label.
2. Tap **Done**. The AI writes all the listings, 3 at a time.
3. Go through the **Check** tab and fix anything the AI flagged, then tap **Ready to list**.
4. **Quick list**: copy each field into Trade Me, save or share the photos, then **Mark listed & next**.
5. When items sell, delete old batches to free up storage.
