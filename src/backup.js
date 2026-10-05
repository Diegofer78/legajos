import { supabase } from "./supabase";

export async function exportarRespaldo() {
  const { data, error } = await supabase.from("kv").select("key,value");
  if (error) throw error;
  const blob = new Blob([JSON.stringify({ version: 1, fecha: new Date().toISOString(), datos: data }, null, 1)], {
    type: "application/json",
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "respaldo-legajos-" + new Date().toISOString().slice(0, 10) + ".json";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  return data.length;
}

export async function importarRespaldo(file) {
  const json = JSON.parse(await file.text());
  const filas = json.datos || [];
  if (!Array.isArray(filas) || !filas.length) throw new Error("Archivo de respaldo vacío o inválido");
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("kv")
    .upsert(filas.map((r) => ({ key: r.key, value: r.value, updated_at: now })));
  if (error) throw error;
  return filas.length;
}
