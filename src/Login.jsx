import { useState } from "react";
import { supabase } from "./supabase";

export default function Login() {
  const [email, setEmail] = useState("");
  const [pass, setPass] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function entrar(e) {
    e.preventDefault();
    setBusy(true);
    setErr("");
    const { error } = await supabase.auth.signInWithPassword({ email, password: pass });
    if (error) setErr("Email o contraseña incorrectos");
    setBusy(false);
  }

  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#f3f1ec", fontFamily: "'IBM Plex Sans', system-ui, sans-serif", padding: 16 }}>
      <form onSubmit={entrar} style={{ background: "#fff", padding: 28, borderRadius: 10, width: "100%", maxWidth: 360, boxShadow: "0 4px 24px rgba(0,0,0,.08)" }}>
        <h2 style={{ margin: "0 0 4px", color: "#263a41" }}>Gestión de Legajos</h2>
        <p style={{ margin: "0 0 18px", color: "#666", fontSize: 14 }}>Ingresá con tu usuario</p>
        <input type="email" required placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} style={inp} />
        <input type="password" required placeholder="Contraseña" value={pass} onChange={(e) => setPass(e.target.value)} style={inp} />
        {err && <div style={{ color: "#b00020", fontSize: 13, marginBottom: 10 }}>{err}</div>}
        <button disabled={busy} style={{ width: "100%", padding: 11, background: "#263a41", color: "#fff", border: 0, borderRadius: 6, fontSize: 15, cursor: "pointer" }}>
          {busy ? "Ingresando..." : "Ingresar"}
        </button>
      </form>
    </div>
  );
}
const inp = { width: "100%", boxSizing: "border-box", padding: 10, marginBottom: 12, border: "1px solid #ccc", borderRadius: 6, fontSize: 15 };
