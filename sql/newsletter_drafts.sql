-- Run once in the Supabase SQL editor before deploying the weekly digest worker.
-- Stores the auto-generated weekly newsletter draft that AdminNewsletterBlast
-- loads for review before sending.

create table if not exists newsletter_drafts (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  subject    text not null,
  body_text  text,
  post_ids   uuid[] not null default '{}',
  status     text not null default 'pending'
               check (status in ('pending', 'sent', 'dismissed')),
  sent_at    timestamptz
);

create index if not exists newsletter_drafts_status_idx
  on newsletter_drafts (status, created_at desc);
