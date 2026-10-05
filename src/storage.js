import { supabase } from "./supabase";

// Implementa window.storage (la API que usa la app) sobre la tabla "kv" de Supabase.
export function installStorage() {
  window.storage = {
    async get(key) {
      const { data, error } = await supabase.from("kv").select("value").eq("key", key).maybeSingle();
      if (error) throw error;
      if (!data) throw new Error("not found: " + key);
      return { key, value: data.value };
    },
    async set(key, value) {
      const { error } = await supabase
        .from("kv")
        .upsert({ key, value: String(value), updated_at: new Date().toISOString() });
      if (error) throw error;
      return { key, value };
    },
    async delete(key) {
      const { error } = await supabase.from("kv").delete().eq("key", key);
      if (error) throw error;
      return { key, deleted: true };
    },
    async list(prefix = "") {
      let q = supabase.from("kv").select("key");
      if (prefix) q = q.like("key", prefix.replace(/[%_]/g, "\\$&") + "%");
      const { data, error } = await q;
      if (error) throw error;
      return { keys: (data || []).map((r) => r.key) };
    },
  };
}
