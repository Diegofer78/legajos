import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { supabase, configured } from "./supabase";
import { installStorage } from "./storage";
import Login from "./Login";
import App from "./App";

if (configured) installStorage();

function Root() {
  const [session, setSession] = useState(undefined);

  useEffect(() => {
    if (!configured) return;
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  if (!configured)
    return (
      <div style={{ padding: 24, fontFamily: "system-ui" }}>
        <h2>Falta configurar Supabase</h2>
        <p>Definí las variables <code>VITE_SUPABASE_URL</code> y <code>VITE_SUPABASE_ANON_KEY</code> (ver README).</p>
      </div>
    );
  if (session === undefined) return <div style={{ padding: 24, fontFamily: "system-ui" }}>Cargando...</div>;
  if (!session) return <Login />;
  return <App key={session.user.id} onLogout={() => supabase.auth.signOut()} />;
}

createRoot(document.getElementById("root")).render(<Root />);
