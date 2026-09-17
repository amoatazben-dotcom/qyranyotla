create extension if not exists pg_cron;

create or replace function private.invoke_media_health()
returns bigint
language plpgsql
security definer
set search_path = pg_catalog, public, net
as $$
declare
  request_id bigint;
begin
  select net.http_post(
    url := 'https://bxhipppxgtpinpzarsav.supabase.co/functions/v1/media-health',
    headers := jsonb_build_object('Content-Type','application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  ) into request_id;
  return request_id;
end;
$$;
revoke all on function private.invoke_media_health() from public, anon, authenticated;
grant execute on function private.invoke_media_health() to service_role;

create or replace function private.invoke_content_sync(p_action text)
returns bigint
language plpgsql
security definer
set search_path = pg_catalog, public, net, vault
as $$
declare
  request_id bigint;
  sync_token text;
begin
  if p_action not in ('quran','thematic','mp3quran','alquran_audio','all') then
    raise exception 'invalid sync action';
  end if;

  select decrypted_secret
  into sync_token
  from vault.decrypted_secrets
  where name = 'QURAN_YUTLA_CONTENT_SYNC_TOKEN'
  limit 1;

  if sync_token is null or length(sync_token) < 20 then
    raise exception 'content sync token missing';
  end if;

  select net.http_post(
    url := 'https://bxhipppxgtpinpzarsav.supabase.co/functions/v1/content-sync',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'x-sync-token',sync_token
    ),
    body := jsonb_build_object('action', p_action),
    timeout_milliseconds := 55000
  ) into request_id;
  return request_id;
end;
$$;
revoke all on function private.invoke_content_sync(text) from public, anon, authenticated;
grant execute on function private.invoke_content_sync(text) to service_role;

do $$
declare j record;
begin
  for j in select jobid from cron.job where jobname in (
    'quran-yutla-media-health',
    'quran-yutla-mp3quran-sync',
    'quran-yutla-alquran-audio-sync',
    'quran-yutla-quran-integrity-sync',
    'quran-yutla-thematic-sync'
  ) loop
    perform cron.unschedule(j.jobid);
  end loop;
end $$;

select cron.schedule('quran-yutla-media-health','*/15 * * * *',$$select private.invoke_media_health();$$);
select cron.schedule('quran-yutla-mp3quran-sync','17 2 * * *',$$select private.invoke_content_sync('mp3quran');$$);
select cron.schedule('quran-yutla-alquran-audio-sync','47 2 * * *',$$select private.invoke_content_sync('alquran_audio');$$);
select cron.schedule('quran-yutla-quran-integrity-sync','7 3 * * 1',$$select private.invoke_content_sync('quran');$$);
select cron.schedule('quran-yutla-thematic-sync','37 3 * * 1',$$select private.invoke_content_sync('thematic');$$);
