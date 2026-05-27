-- Run this in Supabase Dashboard → SQL Editor (or via `supabase db push` if you use CLI)

create table if not exists public.email_open_tracking (
  message_id uuid primary key,
  email text not null,
  open_count integer not null default 0,
  last_opened_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_email_open_tracking_email
  on public.email_open_tracking (email);

-- Atomic increment when tracking pixel is loaded
create or replace function public.increment_email_open(p_message_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.email_open_tracking
  set
    open_count = open_count + 1,
    last_opened_at = timezone('utc', now())
  where message_id = p_message_id;
end;
$$;

-- Edge Function uses service role; block public direct table access
alter table public.email_open_tracking enable row level security;
