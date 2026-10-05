create table if not exists kv (
  key text primary key,
  value text not null,
  updated_at timestamptz default now()
);

alter table kv enable row level security;

create policy "usuarios autenticados" on kv
  for all to authenticated
  using (true) with check (true);
