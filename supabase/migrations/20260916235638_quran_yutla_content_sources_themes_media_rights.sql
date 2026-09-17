create table if not exists app.content_sources (
  id text primary key,
  name text not null,
  source_type text not null check (source_type in ('quran','audio','radio','video','tafsir','hadith','azkar','prayer','library','mixed')),
  api_url text,
  base_url text,
  terms_url text,
  attribution text,
  license_summary text,
  stream_allowed boolean not null default false,
  download_allowed boolean not null default false,
  record_allowed boolean not null default false,
  redistribute_allowed boolean not null default false,
  cache_allowed boolean not null default false,
  enabled boolean not null default true,
  priority integer not null default 100,
  review_status text not null default 'documented' check (review_status in ('documented','community','unverified','restricted')),
  metadata jsonb not null default '{}'::jsonb,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists app.quran_theme_categories (
  id text primary key,
  name_ar text not null,
  color_hex text not null check (color_hex ~ '^#[0-9A-Fa-f]{6}$'),
  sort_order integer not null default 0,
  source_id text references app.content_sources(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb
);

create table if not exists app.quran_thematic_segments (
  id uuid primary key default gen_random_uuid(),
  surah_number integer not null references app.quran_surahs(number) on delete cascade,
  start_ayah integer not null,
  end_ayah integer not null,
  theme_ar text not null,
  description_ar text,
  category_id text references app.quran_theme_categories(id) on delete set null,
  color_hex text not null check (color_hex ~ '^#[0-9A-Fa-f]{6}$'),
  source_id text references app.content_sources(id) on delete set null,
  source_ref text,
  review_status text not null default 'source_unreviewed' check (review_status in ('source_unreviewed','reviewed','approved')),
  created_at timestamptz not null default now(),
  constraint thematic_range_valid check (start_ayah > 0 and end_ayah >= start_ayah),
  unique (surah_number, start_ayah, end_ayah, theme_ar)
);

create index if not exists quran_thematic_segments_surah_idx on app.quran_thematic_segments(surah_number,start_ayah,end_ayah);
create index if not exists quran_thematic_segments_category_idx on app.quran_thematic_segments(category_id);

alter table app.stations add column if not exists source_id text references app.content_sources(id) on delete set null;
alter table app.stations add column if not exists external_id text;
alter table app.stations add column if not exists media_kind text not null default 'audio' check (media_kind in ('audio','video'));
alter table app.stations add column if not exists stream_format text;
alter table app.stations add column if not exists stream_allowed boolean not null default true;
alter table app.stations add column if not exists download_allowed boolean not null default false;
alter table app.stations add column if not exists record_allowed boolean not null default false;
alter table app.stations add column if not exists timeshift_allowed boolean not null default false;
alter table app.stations add column if not exists terms_url text;
alter table app.stations add column if not exists recording_note text;
alter table app.stations add column if not exists last_latency_ms integer;
alter table app.stations add column if not exists failure_streak integer not null default 0;
create unique index if not exists stations_source_external_uidx on app.stations(source_id, external_id) where external_id is not null;

create table if not exists app.station_stream_candidates (
  id uuid primary key default gen_random_uuid(),
  station_id uuid not null references app.stations(id) on delete cascade,
  stream_url text not null,
  priority integer not null default 100,
  source_id text references app.content_sources(id) on delete set null,
  stream_format text,
  is_active boolean not null default true,
  health_status text not null default 'unknown' check (health_status in ('unknown','healthy','degraded','offline')),
  last_health_check_at timestamptz,
  last_latency_ms integer,
  failure_streak integer not null default 0,
  last_error text,
  unique(station_id, stream_url)
);
create index if not exists station_stream_candidates_station_idx on app.station_stream_candidates(station_id,priority);

create table if not exists app.live_channels (
  id uuid primary key default gen_random_uuid(),
  source_id text references app.content_sources(id) on delete set null,
  external_id text not null,
  name_ar text not null,
  name_en text,
  channel_type text not null check (channel_type in ('live_tv','live_video','live_audio')),
  stream_url text not null,
  fallback_stream_url text,
  thumbnail_url text,
  stream_format text,
  stream_allowed boolean not null default true,
  download_allowed boolean not null default false,
  record_allowed boolean not null default false,
  timeshift_allowed boolean not null default false,
  terms_url text,
  rights_note text,
  is_active boolean not null default true,
  health_status text not null default 'unknown' check (health_status in ('unknown','healthy','degraded','offline')),
  last_health_check_at timestamptz,
  last_latency_ms integer,
  failure_streak integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(source_id,external_id)
);

create table if not exists app.video_items (
  id uuid primary key default gen_random_uuid(),
  source_id text references app.content_sources(id) on delete set null,
  external_id text not null,
  reciter_name text,
  title_ar text,
  video_url text not null,
  thumbnail_url text,
  video_type text,
  stream_allowed boolean not null default true,
  download_allowed boolean not null default false,
  rights_note text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique(source_id,external_id)
);

create table if not exists app.tafsir_sources (
  id uuid primary key default gen_random_uuid(),
  source_id text references app.content_sources(id) on delete set null,
  external_id text not null,
  name_ar text not null,
  api_url text not null,
  media_type text not null default 'audio' check (media_type in ('audio','text','mixed')),
  download_allowed boolean not null default false,
  rights_note text,
  is_active boolean not null default true,
  unique(source_id,external_id)
);

create table if not exists app.provider_health (
  source_id text primary key references app.content_sources(id) on delete cascade,
  status text not null default 'unknown' check (status in ('unknown','healthy','degraded','offline')),
  latency_ms integer,
  failure_streak integer not null default 0,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  last_error text,
  checked_at timestamptz not null default now()
);

alter table app.content_sources enable row level security;
alter table app.quran_theme_categories enable row level security;
alter table app.quran_thematic_segments enable row level security;
alter table app.station_stream_candidates enable row level security;
alter table app.live_channels enable row level security;
alter table app.video_items enable row level security;
alter table app.tafsir_sources enable row level security;
alter table app.provider_health enable row level security;

create policy content_sources_public_read on app.content_sources for select to anon, authenticated using (enabled);
create policy theme_categories_public_read on app.quran_theme_categories for select to anon, authenticated using (true);
create policy thematic_segments_public_read on app.quran_thematic_segments for select to anon, authenticated using (true);
create policy station_candidates_public_read on app.station_stream_candidates for select to anon, authenticated using (is_active);
create policy live_channels_public_read on app.live_channels for select to anon, authenticated using (is_active and stream_allowed);
create policy video_items_public_read on app.video_items for select to anon, authenticated using (is_active and stream_allowed);
create policy tafsir_sources_public_read on app.tafsir_sources for select to anon, authenticated using (is_active);
create policy provider_health_public_read on app.provider_health for select to anon, authenticated using (true);

create policy content_sources_admin_insert on app.content_sources for insert to authenticated with check (private.admin_has_permission('settings.write'));
create policy content_sources_admin_update on app.content_sources for update to authenticated using (private.admin_has_permission('settings.write')) with check (private.admin_has_permission('settings.write'));
create policy content_sources_admin_delete on app.content_sources for delete to authenticated using (private.admin_has_permission('settings.write'));
create policy themes_admin_insert on app.quran_thematic_segments for insert to authenticated with check (private.admin_has_permission('media.write'));
create policy themes_admin_update on app.quran_thematic_segments for update to authenticated using (private.admin_has_permission('media.write')) with check (private.admin_has_permission('media.write'));
create policy themes_admin_delete on app.quran_thematic_segments for delete to authenticated using (private.admin_has_permission('media.write'));
create policy live_channels_admin_insert on app.live_channels for insert to authenticated with check (private.admin_has_permission('stations.write'));
create policy live_channels_admin_update on app.live_channels for update to authenticated using (private.admin_has_permission('stations.write')) with check (private.admin_has_permission('stations.write'));
create policy live_channels_admin_delete on app.live_channels for delete to authenticated using (private.admin_has_permission('stations.write'));

revoke all on app.content_sources, app.quran_theme_categories, app.quran_thematic_segments, app.station_stream_candidates, app.live_channels, app.video_items, app.tafsir_sources, app.provider_health from anon, authenticated;
grant select on app.content_sources, app.quran_theme_categories, app.quran_thematic_segments, app.station_stream_candidates, app.live_channels, app.video_items, app.tafsir_sources, app.provider_health to anon, authenticated;
grant insert, update, delete on app.content_sources, app.quran_theme_categories, app.quran_thematic_segments, app.station_stream_candidates, app.live_channels, app.video_items, app.tafsir_sources, app.provider_health to authenticated;
grant all privileges on app.content_sources, app.quran_theme_categories, app.quran_thematic_segments, app.station_stream_candidates, app.live_channels, app.video_items, app.tafsir_sources, app.provider_health to service_role;

do $$ begin
  if not exists (select 1 from pg_indexes where schemaname='app' and indexname='live_channels_source_idx') then
    create index live_channels_source_idx on app.live_channels(source_id);
  end if;
  if not exists (select 1 from pg_indexes where schemaname='app' and indexname='video_items_source_idx') then
    create index video_items_source_idx on app.video_items(source_id);
  end if;
  if not exists (select 1 from pg_indexes where schemaname='app' and indexname='tafsir_sources_source_idx') then
    create index tafsir_sources_source_idx on app.tafsir_sources(source_id);
  end if;
end $$;

insert into app.content_sources(id,name,source_type,api_url,base_url,terms_url,attribution,license_summary,stream_allowed,download_allowed,record_allowed,redistribute_allowed,cache_allowed,priority,review_status,metadata)
values
('alquran_cloud','Al Quran Cloud / Islamic Network','mixed','https://api.alquran.cloud/v1','https://cdn.islamic.network','https://alquran.cloud/terms-and-conditions','Quran text/audio: Al Quran Cloud / Islamic Network','Quran text may be stored/displayed with attribution; recitations may be streamed/embedded/downloaded for personal and educational use; copyrights remain with reciters.',true,true,false,false,true,10,'documented','{"quran_text":true,"ayah_audio":true,"surah_audio":true,"ayah_images":true,"tajweed":true}'::jsonb),
('mp3quran','MP3Quran.net','mixed','https://www.mp3quran.net/api/v3','https://www.mp3quran.net','https://www.mp3quran.net/ar/api','MP3Quran.net developer API','Developer API publishes reciter, radio, tafsir, video and live-TV URLs. Streaming enabled; downloading/recording live streams remains disabled unless a source-specific license is documented.',true,false,false,false,true,20,'documented','{"reciters":true,"radios":true,"tafasir":true,"videos":true,"live_tv":true}'::jsonb),
('islamic_library_data','Islamic App Data (community open dataset)','mixed','https://cdn.jsdelivr.net/gh/mohammed-2-5/islamic-library-data@master','https://github.com/mohammed-2-5/islamic-library-data','https://github.com/mohammed-2-5/islamic-library-data','Islamic App Data repository','Community open dataset. Thematic Quran segmentation is used as an auxiliary study overlay and is not presented as canonical Quran text or a scholarly ruling.',false,true,false,false,true,60,'community','{"thematic_segments":745,"tajweed_rules":true,"hadith":true,"azkar":true,"library_catalog":true}'::jsonb),
('fawaz_hadith','Fawaz Ahmed Hadith API','hadith','https://cdn.jsdelivr.net/gh/fawazahmed0/hadith-api@1','https://github.com/fawazahmed0/hadith-api','https://github.com/fawazahmed0/hadith-api','Hadith API community dataset','Unlicense project; Arabic/translated hadith editions with grades. Treat as community data and retain collection/source attribution.',false,true,false,true,true,70,'community','{}'::jsonb)
on conflict(id) do update set
 name=excluded.name,source_type=excluded.source_type,api_url=excluded.api_url,base_url=excluded.base_url,terms_url=excluded.terms_url,attribution=excluded.attribution,license_summary=excluded.license_summary,stream_allowed=excluded.stream_allowed,download_allowed=excluded.download_allowed,record_allowed=excluded.record_allowed,redistribute_allowed=excluded.redistribute_allowed,cache_allowed=excluded.cache_allowed,priority=excluded.priority,review_status=excluded.review_status,metadata=excluded.metadata,updated_at=now();
