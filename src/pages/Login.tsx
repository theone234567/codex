import { useState, type FormEvent } from "react";
import { supabase } from "../lib/supabase";
import { isEmail, normalizePhone } from "../lib/phone";

type Step = { kind: "enter" } | { kind: "code"; email?: string; phone?: string };

export default function Login() {
  const [mode, setMode] = useState<"email" | "phone">("email");
  const [value, setValue] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<Step>({ kind: "enter" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function sendCode(e: FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      if (mode === "email") {
        if (!isEmail(value)) throw new Error("Enter a valid email address");
        const email = value.trim().toLowerCase();
        const { error } = await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
        if (error) throw error;
        setStep({ kind: "code", email });
      } else {
        const phone = normalizePhone(value);
        if (!phone) throw new Error("Enter a valid mobile number, e.g. 021 123 4567");
        const { error } = await supabase.auth.signInWithOtp({ phone, options: { shouldCreateUser: false } });
        if (error) throw error;
        setStep({ kind: "code", phone });
      }
    } catch (err) {
      // Same message whether or not the account exists, so the form can't be used to discover accounts.
      console.warn(err);
      setError(err instanceof Error && err.message.startsWith("Enter") ? err.message
        : "Couldn't send a code. Check the address/number, or wait a minute and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function verify(e: FormEvent) {
    e.preventDefault();
    if (step.kind !== "code") return;
    setError("");
    setBusy(true);
    const token = code.replace(/\D/g, "");
    const { error } = step.email
      ? await supabase.auth.verifyOtp({ email: step.email, token, type: "email" })
      : await supabase.auth.verifyOtp({ phone: step.phone!, token, type: "sms" });
    setBusy(false);
    if (error) setError("That code didn't work. Check it, or request a new one.");
  }

  return (
    <main className="page narrow login">
      <h1 className="logo">klick<span>List</span></h1>
      <p className="muted">Snap it. AI writes it. List it.</p>

      {step.kind === "enter" ? (
        <form onSubmit={sendCode} className="card stack">
          <div className="tabs">
            <button type="button" className={mode === "email" ? "on" : ""} onClick={() => { setMode("email"); setValue(""); }}>Email</button>
            <button type="button" className={mode === "phone" ? "on" : ""} onClick={() => { setMode("phone"); setValue(""); }}>Phone</button>
          </div>
          <label>
            {mode === "email" ? "Email address" : "Mobile number"}
            <input
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              type={mode === "email" ? "email" : "tel"}
              inputMode={mode === "email" ? "email" : "tel"}
              autoComplete={mode === "email" ? "email" : "tel"}
              placeholder={mode === "email" ? "you@example.com" : "021 123 4567"}
              maxLength={254}
            />
          </label>
          <button className="primary" disabled={busy || !value}>{busy ? "Sending…" : "Send me a code"}</button>
        </form>
      ) : (
        <form onSubmit={verify} className="card stack">
          <p>We sent a 6-digit code to <b>{step.email ?? step.phone}</b>.</p>
          <label>
            Code
            <input
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value)}
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9 ]*"
              maxLength={8}
              placeholder="123456"
            />
          </label>
          <button className="primary" disabled={busy || code.replace(/\D/g, "").length < 6}>{busy ? "Checking…" : "Sign in"}</button>
          <button type="button" className="link" onClick={() => { setStep({ kind: "enter" }); setCode(""); setError(""); }}>Use a different email/number</button>
        </form>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </main>
  );
}
