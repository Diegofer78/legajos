# Gestión de Legajos — versión web

App web (React + Vite) con base de datos en la nube (Supabase) y login. Se instala en el celular como una app.

## Paso 1 — Cuentas (gratis)
1. GitHub: https://github.com
2. Supabase: https://supabase.com (ingresar con GitHub)
3. Vercel: https://vercel.com (ingresar con GitHub)

## Paso 2 — Base de datos (Supabase)
1. **New project** → poné un nombre y una contraseña de base de datos (guardala). Elegí la región más cercana (South America).
2. Menú **SQL Editor** → **New query** → pegá el contenido de `supabase/schema.sql` → **Run**.
3. Menú **Authentication → Users → Add user → Create new user**: cargá tu email y contraseña (tildá "Auto Confirm User"). Hacelo para cada persona que deba entrar.
4. Menú **Authentication → Sign In / Providers** (o Settings): **desactivá "Allow new users to sign up"**, así nadie más puede registrarse.
5. Menú **Project Settings → API**: copiá **Project URL** y la clave **anon public**.

## Paso 3 — Subir a GitHub
1. En GitHub: **New repository** → nombre `legajos` → **Private** → Create.
2. **uploading an existing file** → arrastrá TODO el contenido de esta carpeta (sin `node_modules` ni `dist`) → **Commit changes**.

## Paso 4 — Publicar en Vercel
1. **Add New → Project** → importá el repo `legajos`.
2. En **Environment Variables** agregá:
   - `VITE_SUPABASE_URL` = Project URL
   - `VITE_SUPABASE_ANON_KEY` = clave anon public
3. **Deploy**. Vercel te da una dirección tipo `https://legajos-xxxx.vercel.app`.

## Paso 5 — Celular
Abrí la dirección en Chrome (Android) o Safari (iPhone) → menú → **Agregar a pantalla de inicio**.

## Actualizaciones
Cambiás los archivos en GitHub (Add file → Upload files) y Vercel publica solo.

## Datos que ya tenías
Si tenés datos en la versión anterior, usá "Exportar respaldo" allí y luego "Importar respaldo" en la versión web (barra lateral, abajo).

## Tener en cuenta
- Supabase gratis pausa el proyecto tras ~1 semana sin uso (se reactiva desde su panel, sin perder datos).
- Si dos personas editan el mismo momento, gana el último en guardar.
- Imprimir desde el celular es más incómodo que desde una PC; el guardado automático en carpeta de Windows no existe en web (se descarga el archivo).
- Desarrollo local: copiá `.env.example` a `.env`, completá y corré `npm install && npm run dev`.
