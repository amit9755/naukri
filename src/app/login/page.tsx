"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
export default function Login() {
  const router = useRouter();
  useEffect(() => { const timer = setTimeout(() => { void fetch("/api/auth/session", { method: "POST" }).then((response) => { if (response.ok) router.replace("/dashboard"); }).catch(() => {}); }, 0); return () => clearTimeout(timer); }, [router]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return <main className="login-shell"><form className="panel login" onSubmit={async (event) => {
    event.preventDefault(); setBusy(true); setError("");
    const form = event.currentTarget; const values = new FormData(form);
    try {
      const response = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: values.get("email"), password: values.get("password") }) });
      if (!response.ok) throw new Error();
      form.reset(); router.replace("/dashboard");
    } catch { setError("Sign-in was not accepted. Check your dashboard account or try again later."); }
    finally { setBusy(false); }
  }}><span className="eyebrow">PRIVATE CONTROL ROOM</span><h1>Naukri Automation</h1><p>Sign in with your dashboard account. This is separate from your Naukri login.</p>
    <label>Email<input name="email" type="email" autoComplete="username" required /></label>
    <label>Password<input name="password" type="password" autoComplete="current-password" required /></label>
    {error && <p role="alert" className="error">{error}</p>}<button disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button></form></main>;
}
