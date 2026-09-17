create or replace function private.invoke_media_health()
returns bigint
language plpgsql
security definer
set search_path = pg_catalog, public, net, vault
as $$
declare
  request_id bigint;
  sync_token text;
begin
  select decrypted_secret
  into sync_token
  from vault.decrypted_secrets
  where name = 'QURAN_YUTLA_CONTENT_SYNC_TOKEN'
  limit 1;

  if sync_token is null or length(sync_token) < 20 then
    raise exception 'content sync token missing';
  end if;

  select net.http_post(
    url := 'https://bxhipppxgtpinpzarsav.supabase.co/functions/v1/media-health',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'x-sync-token',sync_token
    ),
    body := jsonb_build_object('refresh_catalog', true),
    timeout_milliseconds := 55000
  ) into request_id;
  return request_id;
end;
$$;
revoke all on function private.invoke_media_health() from public, anon, authenticated;
grant execute on function private.invoke_media_health() to service_role;
