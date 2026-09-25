/** Turn Supabase sign-in errors into plain-English reasons (this is a private, single-owner app). */
export function explainAuthError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  if (/invalid api key|no api key|apikey|jwt/i.test(msg)) {
    return "The website's Supabase key is wrong or incomplete. Check VITE_SUPABASE_ANON_KEY in Cloudflare, then redeploy.";
  }
  if (/not authori[sz]ed/i.test(msg)) {
    return "Supabase's built-in email only sends to members of your Supabase team. Use the email you log in to Supabase with, or set up your own email (SMTP) in Supabase.";
  }
  if (/rate limit|too many|security purposes|over_email_send_rate/i.test(msg)) {
    return "Too many sign-in emails were requested. Wait a few minutes (Supabase's free email sends only a few per hour), then try again.";
  }
  if (/signups? not allowed|user not found|otp_disabled/i.test(msg)) {
    return "This email isn't registered. Add it in Supabase → Authentication → Users (tick Auto Confirm).";
  }
  if (/failed to fetch|network|load failed/i.test(msg)) {
    return "Couldn't reach Supabase. Check VITE_SUPABASE_URL in Cloudflare and your internet connection.";
  }
  return `Couldn't send a code: ${msg.slice(0, 200) || "unknown error"}`;
}
