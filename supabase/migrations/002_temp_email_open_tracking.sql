-- Run once in Supabase Dashboard → SQL Editor to enable test:* scripts.
-- Creates a parallel TEMP_email_open_tracking table + TEMP_increment_email_open RPC
-- so `bun run test:send` / `test:sync` never touch the prod email_open_tracking table.

create table if not exists public."TEMP_email_open_tracking" (
  message_id uuid primary key,
  email text not null,
  open_count integer not null default 0,
  last_opened_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_temp_email_open_tracking_email
  on public."TEMP_email_open_tracking" (email);

create or replace function public."TEMP_increment_email_open"(p_message_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public."TEMP_email_open_tracking"
  set
    open_count = open_count + 1,
    last_opened_at = timezone('utc', now())
  where message_id = p_message_id;
end;
$$;

alter table public."TEMP_email_open_tracking" enable row level security;
