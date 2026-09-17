-- Public read helpers do not need elevated privileges because the underlying
-- tables already have explicit RLS policies for anon/authenticated.
alter function public.adhkar_public_audio(text) security invoker;
alter function public.adhkar_public_categories() security invoker;
alter function public.adhkar_public_items(text,text,integer,integer,text) security invoker;
alter function public.adhkar_public_schedules() security invoker;
alter function public.adhkar_public_sources() security invoker;

drop policy if exists adhkar_import_runs_no_client_access on public.adhkar_import_runs;
create policy adhkar_import_runs_no_client_access
on public.adhkar_import_runs
for all
to anon, authenticated
using (false)
with check (false);

drop policy if exists adhkar_favorites_select_own on public.adhkar_favorites;
create policy adhkar_favorites_select_own on public.adhkar_favorites
for select to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists adhkar_favorites_insert_own on public.adhkar_favorites;
create policy adhkar_favorites_insert_own on public.adhkar_favorites
for insert to authenticated
with check ((select auth.uid()) = user_id);

drop policy if exists adhkar_favorites_delete_own on public.adhkar_favorites;
create policy adhkar_favorites_delete_own on public.adhkar_favorites
for delete to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists adhkar_progress_select_own on public.adhkar_progress;
create policy adhkar_progress_select_own on public.adhkar_progress
for select to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists adhkar_progress_insert_own on public.adhkar_progress;
create policy adhkar_progress_insert_own on public.adhkar_progress
for insert to authenticated
with check ((select auth.uid()) = user_id);

drop policy if exists adhkar_progress_update_own on public.adhkar_progress;
create policy adhkar_progress_update_own on public.adhkar_progress
for update to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

drop policy if exists adhkar_progress_delete_own on public.adhkar_progress;
create policy adhkar_progress_delete_own on public.adhkar_progress
for delete to authenticated
using ((select auth.uid()) = user_id);

create index if not exists quran_thematic_segments_source_idx on app.quran_thematic_segments(source_id);
create index if not exists quran_theme_categories_source_idx on app.quran_theme_categories(source_id);
create index if not exists station_stream_candidates_source_idx on app.station_stream_candidates(source_id);
create index if not exists adhkar_audio_reader_idx on public.adhkar_audio(reader_id);
create index if not exists adhkar_favorites_adhkar_idx on public.adhkar_favorites(adhkar_id);
create index if not exists adhkar_import_runs_source_idx on public.adhkar_import_runs(source_id);
create index if not exists adhkar_item_sources_source_idx on public.adhkar_item_sources(source_id);
create index if not exists adhkar_items_preferred_audio_idx on public.adhkar_items(preferred_audio_id);
create index if not exists adhkar_progress_adhkar_idx on public.adhkar_progress(adhkar_id);
create index if not exists adhkar_schedule_templates_category_idx on public.adhkar_schedule_templates(category_id);
