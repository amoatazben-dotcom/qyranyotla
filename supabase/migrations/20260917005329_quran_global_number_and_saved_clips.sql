alter table app.quran_ayahs add column if not exists global_number integer;

with numbered as (
  select id, row_number() over (order by surah_number, ayah_number)::integer as global_number
  from app.quran_ayahs
)
update app.quran_ayahs q
set global_number = n.global_number
from numbered n
where q.id = n.id
  and q.global_number is distinct from n.global_number;

alter table app.quran_ayahs alter column global_number set not null;
do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname='quran_ayahs_global_number_check'
      and conrelid='app.quran_ayahs'::regclass
  ) then
    alter table app.quran_ayahs add constraint quran_ayahs_global_number_check check(global_number between 1 and 6236);
  end if;
end $$;
create unique index if not exists quran_ayahs_global_number_uidx on app.quran_ayahs(global_number);

create table if not exists app.saved_media_clips (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  installation_id uuid,
  source_type text not null check(source_type in ('radio','live_channel','quran_audio','video','external_audio')),
  source_reference text not null,
  title text,
  start_seconds integer not null default 0 check(start_seconds >= 0),
  end_seconds integer check(end_seconds is null or end_seconds > start_seconds),
  local_only boolean not null default true,
  local_file_name text,
  local_sha256 text,
  rights_snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint saved_media_clips_owner_required check(user_id is not null or installation_id is not null)
);
alter table app.saved_media_clips enable row level security;

create policy saved_clips_select_own_user on app.saved_media_clips
for select to authenticated
using ((select auth.uid()) = user_id);
create policy saved_clips_insert_own_user on app.saved_media_clips
for insert to authenticated
with check ((select auth.uid()) = user_id);
create policy saved_clips_update_own_user on app.saved_media_clips
for update to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);
create policy saved_clips_delete_own_user on app.saved_media_clips
for delete to authenticated
using ((select auth.uid()) = user_id);

grant select, insert, update, delete on app.saved_media_clips to authenticated;
grant all on app.saved_media_clips to service_role;

create index if not exists saved_media_clips_user_time_idx on app.saved_media_clips(user_id, created_at desc);
create index if not exists saved_media_clips_install_time_idx on app.saved_media_clips(installation_id, created_at desc);
