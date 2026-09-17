import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, x-request-id",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json; charset=utf-8",
};

function reply(data: unknown, status = 200, requestId = crypto.randomUUID()) {
  return new Response(JSON.stringify(data), { status, headers: { ...cors, "X-Request-Id": requestId } });
}
async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function dbFetch(path: string, init: RequestInit = {}, profile = "app") {
  const headers = new Headers(init.headers ?? {});
  headers.set("apikey", SERVICE_ROLE);
  headers.set("Authorization", `Bearer ${SERVICE_ROLE}`);
  headers.set("Accept-Profile", profile);
  headers.set("Content-Profile", profile);
  headers.set("Content-Type", "application/json");
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers });
}
async function dbJson(path: string, profile = "app") {
  const res = await dbFetch(path, {}, profile);
  if (!res.ok) throw new Error(`DB_${res.status}_${path}`);
  return await res.json();
}
async function dbCount(path: string, profile = "app") {
  const res = await dbFetch(path, { headers: { Prefer: "count=exact", Range: "0-0" } }, profile);
  if (!res.ok) throw new Error(`DB_COUNT_${res.status}_${path}`);
  const range = res.headers.get("content-range") ?? "";
  const m = range.match(/\/(\d+)$/);
  return m ? Number(m[1]) : 0;
}
async function rpc(name: string, body: Record<string, unknown> = {}) {
  const res = await dbFetch(`rpc/${name}`, { method: "POST", body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`RPC_${name}_${res.status}`);
  return res.json();
}
const healthRank: Record<string, number> = { healthy: 0, degraded: 1, unknown: 2, offline: 3 };
function chooseCandidate(station: any, candidates: any[]) {
  const sorted = candidates.filter((c) => c.station_id === station.id && c.is_active).sort((a, b) =>
    (healthRank[a.health_status] ?? 9) - (healthRank[b.health_status] ?? 9) || Number(a.priority) - Number(b.priority) || Number(a.last_latency_ms ?? 999999) - Number(b.last_latency_ms ?? 999999));
  const usable = sorted.find((c) => c.health_status !== "offline") ?? null;
  if (usable) return { url: usable.stream_url, source: "candidate", health_status: usable.health_status, latency_ms: usable.last_latency_ms };
  if (station.health_status !== "offline") return { url: station.stream_url, source: "primary", health_status: station.health_status, latency_ms: station.last_latency_ms };
  if (station.fallback_stream_url) return { url: station.fallback_stream_url, source: "fallback", health_status: "unknown", latency_ms: null };
  return null;
}
function intParam(url: URL, key: string, fallback: number, min: number, max: number) {
  const v = Number(url.searchParams.get(key) ?? fallback);
  return Number.isInteger(v) ? Math.min(max, Math.max(min, v)) : fallback;
}

Deno.serve(async (req: Request) => {
  const requestId = req.headers.get("x-request-id") ?? crypto.randomUUID();
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (!SUPABASE_URL || !SERVICE_ROLE) return reply({ error: { code: "SERVER_CONFIG_MISSING", message: "Backend configuration missing", request_id: requestId } }, 500, requestId);
  try {
    const url = new URL(req.url);
    let path = url.pathname;
    const marker = "/quran-yutla-api";
    const idx = path.indexOf(marker);
    if (idx >= 0) path = path.slice(idx + marker.length);
    if (!path) path = "/";

    if (req.method === "GET" && (path === "/" || path === "/health")) {
      const [ayahs, surahs, pages, stations, reciters, themes, videos, live] = await Promise.all([
        dbCount("quran_ayahs?select=id"), dbCount("quran_surahs?select=number"), dbCount("quran_pages?select=id"),
        dbCount("stations?is_active=eq.true&select=id"), dbCount("reciters?is_active=eq.true&select=id"),
        dbCount("quran_thematic_segments?select=id"), dbCount("video_items?is_active=eq.true&select=id"), dbCount("live_channels?is_active=eq.true&select=id")
      ]);
      const canonicalOk = surahs === 114 && ayahs === 6236 && pages === 604;
      return reply({ status: canonicalOk ? "healthy" : "degraded", service: "quran-yutla-api", version: "1.2.1", canonical_quran_ok: canonicalOk, counts: { quran_surahs: surahs, quran_ayahs: ayahs, quran_pages: pages, stations, reciters, themes, videos, live_channels: live }, timestamp: new Date().toISOString() }, canonicalOk ? 200 : 503, requestId);
    }
    if (req.method === "GET" && path === "/runtime-config") return reply(await rpc("get_public_config"), 200, requestId);
    if (req.method === "GET" && path === "/home") return reply(await rpc("get_public_home"), 200, requestId);
    if (req.method === "GET" && path === "/reciters") return reply(await rpc("get_public_reciters"), 200, requestId);

    if (req.method === "GET" && path === "/content/sources") {
      return reply(await dbJson("content_sources?enabled=eq.true&select=id,name,source_type,api_url,base_url,terms_url,attribution,license_summary,stream_allowed,download_allowed,record_allowed,clip_allowed,redistribute_allowed,cache_allowed,review_status,last_synced_at&order=priority.asc"), 200, requestId);
    }
    if (req.method === "GET" && path === "/media/capabilities") {
      const [stations, channels, videos, mappings] = await Promise.all([
        dbJson("stations?is_active=eq.true&select=id,stream_allowed,download_allowed,record_allowed,timeshift_allowed,clip_allowed,health_status"),
        dbJson("live_channels?is_active=eq.true&select=id,stream_allowed,download_allowed,record_allowed,timeshift_allowed,clip_allowed,health_status"),
        dbJson("video_items?is_active=eq.true&select=id,stream_allowed,download_allowed"),
        dbJson("reciter_provider_mappings?is_active=eq.true&select=id,provider_id,stream_allowed,download_allowed,clip_allowed")
      ]);
      const count = (rows:any[], k:string) => rows.filter((x:any)=>x[k]===true).length;
      return reply({ stations:{total:stations.length,stream:count(stations,"stream_allowed"),download:count(stations,"download_allowed"),record:count(stations,"record_allowed"),timeshift:count(stations,"timeshift_allowed"),clip:count(stations,"clip_allowed"),healthy:stations.filter((x:any)=>x.health_status==="healthy").length}, live_channels:{total:channels.length,stream:count(channels,"stream_allowed"),download:count(channels,"download_allowed"),record:count(channels,"record_allowed"),timeshift:count(channels,"timeshift_allowed"),clip:count(channels,"clip_allowed"),healthy:channels.filter((x:any)=>x.health_status==="healthy").length}, videos:{total:videos.length,stream:count(videos,"stream_allowed"),download:count(videos,"download_allowed")}, recitation_catalogs:{total:mappings.length,stream:count(mappings,"stream_allowed"),download:count(mappings,"download_allowed"),clip:count(mappings,"clip_allowed")}, policy:"Client must enforce per-item rights flags. Stream recording and download remain disabled unless explicitly permitted by the source record." }, 200, requestId);
    }
    if (req.method === "GET" && path === "/stations") {
      const [stations, candidates] = await Promise.all([
        dbJson("stations?is_active=eq.true&is_playable=eq.true&select=id,slug,name_ar,name_en,description,logo_url,stream_url,fallback_stream_url,source_type,provider_name,country,bitrate_kbps,is_featured,health_status,last_health_check_at,last_latency_ms,failure_streak,stream_allowed,download_allowed,record_allowed,timeshift_allowed,clip_allowed,rights_note,recording_note,terms_url,media_kind,stream_format&order=is_featured.desc"),
        dbJson("station_stream_candidates?is_active=eq.true&select=station_id,stream_url,priority,health_status,last_health_check_at,last_latency_ms,failure_streak,is_active&order=priority.asc")
      ]);
      return reply(stations.map((s:any)=>{const resolved=chooseCandidate(s,candidates);return {...s,resolved,playable_now:Boolean(resolved)&&s.stream_allowed===true};}).sort((a:any,b:any)=>(healthRank[a.resolved?.health_status??"offline"]??9)-(healthRank[b.resolved?.health_status??"offline"]??9)), 200, requestId);
    }
    const stationResolve = path.match(/^\/stations\/([0-9a-fA-F-]{36})\/resolve$/);
    if (req.method === "GET" && stationResolve) {
      const rows=await dbJson(`stations?id=eq.${stationResolve[1]}&is_active=eq.true&select=id,slug,name_ar,stream_url,fallback_stream_url,health_status,last_latency_ms,stream_allowed,download_allowed,record_allowed,timeshift_allowed,clip_allowed,rights_note,recording_note,terms_url&limit=1`);
      if(!rows.length) return reply({error:{code:"STATION_NOT_FOUND",message:"Station not found",request_id:requestId}},404,requestId);
      const candidates=await dbJson(`station_stream_candidates?station_id=eq.${stationResolve[1]}&is_active=eq.true&select=station_id,stream_url,priority,health_status,last_latency_ms,failure_streak,is_active&order=priority.asc`);
      const s=rows[0], resolved=chooseCandidate(s,candidates);
      return reply({station_id:s.id,name_ar:s.name_ar,resolved,playable_now:Boolean(resolved)&&s.stream_allowed,rights:{stream:s.stream_allowed,download:s.download_allowed,record:s.record_allowed,timeshift:s.timeshift_allowed,clip:s.clip_allowed,note:s.rights_note,recording_note:s.recording_note,terms_url:s.terms_url}},resolved?200:503,requestId);
    }
    if (req.method === "GET" && path === "/live-channels") {
      const rows=await dbJson("live_channels?is_active=eq.true&select=id,source_id,external_id,name_ar,name_en,channel_type,stream_url,fallback_stream_url,thumbnail_url,stream_format,stream_allowed,download_allowed,record_allowed,timeshift_allowed,clip_allowed,rights_note,health_status,last_health_check_at,last_latency_ms,failure_streak&order=name_ar.asc");
      return reply(rows.map((x:any)=>({...x,playable_now:x.stream_allowed&&x.health_status!=="offline"})),200,requestId);
    }
    if (req.method === "GET" && path === "/videos") {
      const limit=intParam(url,"limit",50,1,100), offset=intParam(url,"offset",0,0,10000);
      return reply(await dbJson(`video_items?is_active=eq.true&select=id,source_id,external_id,reciter_name,title_ar,video_url,thumbnail_url,video_type,stream_allowed,download_allowed,rights_note&order=created_at.desc&limit=${limit}&offset=${offset}`),200,requestId);
    }
    if (req.method === "GET" && path === "/quran/themes") {
      const [categories,segments]=await Promise.all([dbJson("quran_theme_categories?select=id,name_ar,color_hex,sort_order,source_id,metadata&order=sort_order.asc"),dbJson("quran_thematic_segments?select=id,surah_number,start_ayah,end_ayah,theme_ar,description_ar,category_id,color_hex,source_id,source_ref,review_status&order=surah_number.asc,start_ayah.asc")]);
      return reply({categories,segments,disclaimer:"Thematic segmentation is an overlay and never modifies the canonical Quran text. review_status identifies source/review level."},200,requestId);
    }
    const themeSurah=path.match(/^\/quran\/themes\/surah\/(\d{1,3})$/);
    if(req.method==="GET"&&themeSurah){const n=Number(themeSurah[1]);if(n<1||n>114)return reply({error:{code:"INVALID_SURAH",message:"Surah must be 1..114",request_id:requestId}},400,requestId);return reply(await dbJson(`quran_thematic_segments?surah_number=eq.${n}&select=id,surah_number,start_ayah,end_ayah,theme_ar,description_ar,category_id,color_hex,source_id,source_ref,review_status&order=start_ayah.asc`),200,requestId);}

    const reciterTracks=path.match(/^\/reciters\/([0-9a-fA-F-]{36})\/tracks$/);
    if(req.method==="GET"&&reciterTracks)return reply(await rpc("get_reciter_tracks",{p_reciter_id:reciterTracks[1]}),200,requestId);
    const reciterAudio=path.match(/^\/reciters\/([0-9a-fA-F-]{36})\/audio$/);
    if(req.method==="GET"&&reciterAudio){
      const surah=Number(url.searchParams.get("surah")??0), ayah=Number(url.searchParams.get("ayah")??0);
      if(surah<1||surah>114)return reply({error:{code:"INVALID_SURAH",message:"surah=1..114 required",request_id:requestId}},400,requestId);
      if(ayah>0){const verse=await dbJson(`quran_ayahs?surah_number=eq.${surah}&ayah_number=eq.${ayah}&select=global_number,verse_key&limit=1`);if(!verse.length)return reply({error:{code:"AYAH_NOT_FOUND",message:"Ayah not found",request_id:requestId}},404,requestId);const maps=await dbJson(`reciter_provider_mappings?reciter_id=eq.${reciterAudio[1]}&provider_id=eq.alquran_cloud&is_active=eq.true&stream_allowed=eq.true&select=provider_id,provider_reciter_id,riwayah,moshaf,bitrate,audio_url_template,download_allowed,clip_allowed,rights_note&limit=1`);if(!maps.length)return reply({error:{code:"AYAH_AUDIO_UNAVAILABLE",message:"This reciter has no verified ayah-level provider mapping",request_id:requestId}},404,requestId);const m=maps[0],bitrate=Number(m.bitrate??128),audio_url=String(m.audio_url_template).replace("{bitrate}",String(bitrate)).replace("{global_ayah}",String(verse[0].global_number));return reply({kind:"ayah",reciter_id:reciterAudio[1],surah_number:surah,ayah_number:ayah,verse_key:verse[0].verse_key,global_number:verse[0].global_number,provider_id:m.provider_id,audio_url,bitrate,rights:{stream:true,download:m.download_allowed,clip:m.clip_allowed,note:m.rights_note},identity:{provider_reciter_id:m.provider_reciter_id,riwayah:m.riwayah,moshaf:m.moshaf}},200,requestId);}
      const tracks=await dbJson(`quran_audio_tracks?reciter_id=eq.${reciterAudio[1]}&surah_number=eq.${surah}&ayah_number=is.null&is_active=eq.true&select=id,provider_id,surah_number,bitrate,audio_url,track_kind,download_allowed,clip_allowed,rights_note,metadata&limit=5`);if(!tracks.length)return reply({error:{code:"SURAH_AUDIO_UNAVAILABLE",message:"No verified whole-surah track for this reciter",request_id:requestId}},404,requestId);return reply({kind:"surah",reciter_id:reciterAudio[1],surah_number:surah,tracks:tracks.map((t:any)=>({...t,rights:{stream:true,download:t.download_allowed,clip:t.clip_allowed,note:t.rights_note}}))},200,requestId);
    }
    const surahMatch=path.match(/^\/quran\/surah\/(\d{1,3})$/);
    if(req.method==="GET"&&surahMatch){const n=Number(surahMatch[1]);if(n<1||n>114)return reply({error:{code:"INVALID_SURAH",message:"Surah must be 1..114",request_id:requestId}},400,requestId);const [verses,themes]=await Promise.all([dbJson(`quran_ayahs?surah_number=eq.${n}&select=global_number,surah_number,ayah_number,verse_key,page_number,juz_number,hizb_number,rub_number,ruku_number,sajdah,text_uthmani,text_imlaei_simple,text_tajweed&order=ayah_number.asc`),dbJson(`quran_thematic_segments?surah_number=eq.${n}&select=id,start_ayah,end_ayah,theme_ar,description_ar,category_id,color_hex,review_status&order=start_ayah.asc`)]);return reply({surah_number:n,verses,themes},200,requestId);}
    const pageMatch=path.match(/^\/quran\/page\/(\d{1,3})$/);
    if(req.method==="GET"&&pageMatch){const n=Number(pageMatch[1]);if(n<1||n>604)return reply({error:{code:"INVALID_PAGE",message:"Page must be 1..604",request_id:requestId}},400,requestId);const [manifest,verses]=await Promise.all([dbJson(`quran_pages?page_number=eq.${n}&select=page_number,edition,asset_path,sha256,width,height,manifest_version`),dbJson(`quran_ayahs?page_number=eq.${n}&select=global_number,surah_number,ayah_number,verse_key,page_number,juz_number,text_uthmani,text_imlaei_simple,text_tajweed&order=global_number.asc`)]);const surahs=[...new Set(verses.map((v:any)=>v.surah_number))];let themes:any[]=[];if(surahs.length)themes=await dbJson(`quran_thematic_segments?surah_number=in.(${surahs.join(",")})&select=id,surah_number,start_ayah,end_ayah,theme_ar,description_ar,category_id,color_hex,review_status&order=surah_number.asc,start_ayah.asc`);const keys=new Set(verses.map((v:any)=>`${v.surah_number}:${v.ayah_number}`));themes=themes.filter((t:any)=>{for(let a=Number(t.start_ayah);a<=Number(t.end_ayah);a++)if(keys.has(`${t.surah_number}:${a}`))return true;return false;});return reply({page_number:n,total_pages:604,manifest:manifest[0]??null,verses,themes},200,requestId);}

    if(req.method==="POST"&&path==="/installations/register"){const body=await req.json();const {installation_id,installation_secret,fcm_token,platform,app_version,build_number,locale,timezone,consent_version,preferences}=body??{};if(!installation_id||!installation_secret||!fcm_token||!platform||!app_version||!consent_version)return reply({error:{code:"MISSING_FIELDS",message:"Required installation registration fields are missing",request_id:requestId}},400,requestId);if(!/^[0-9a-fA-F-]{36}$/.test(installation_id)||String(installation_secret).length<24||String(fcm_token).length<20)return reply({error:{code:"INVALID_FIELDS",message:"Invalid installation credentials",request_id:requestId}},400,requestId);if(!["android","ios","web"].includes(platform))return reply({error:{code:"INVALID_PLATFORM",message:"Invalid platform",request_id:requestId}},400,requestId);const secretHash=await sha256(String(installation_secret));const row={id:installation_id,installation_secret_hash:secretHash,platform,app_version:String(app_version),build_number:Number(build_number??1),locale:String(locale??"ar").slice(0,16),timezone:String(timezone??"UTC").slice(0,64),notifications_enabled:true,firebase_token:String(fcm_token),consent_version:String(consent_version).slice(0,64),consented_at:new Date().toISOString(),last_seen_at:new Date().toISOString(),revoked_at:null,updated_at:new Date().toISOString()};const res=await dbFetch("installations?on_conflict=id",{method:"POST",headers:{Prefer:"resolution=merge-duplicates,return=minimal"},body:JSON.stringify(row)});if(!res.ok)throw new Error(`INSTALLATION_UPSERT_${res.status}`);if(preferences&&typeof preferences==="object"){const pref={installation_id,prayer_enabled:Boolean(preferences.prayer_enabled??false),adhkar_enabled:Boolean(preferences.adhkar_enabled??true),learning_enabled:Boolean(preferences.learning_enabled??true),announcements_enabled:Boolean(preferences.announcements_enabled??true),product_updates_enabled:Boolean(preferences.product_updates_enabled??false),updated_at:new Date().toISOString()};const pRes=await dbFetch("notification_preferences?on_conflict=installation_id",{method:"POST",headers:{Prefer:"resolution=merge-duplicates,return=minimal"},body:JSON.stringify(pref)});if(!pRes.ok)throw new Error(`PREFERENCES_UPSERT_${pRes.status}`);}return reply({success:true,installation_id,registered_at:new Date().toISOString()},201,requestId);}
    if(req.method==="POST"&&path==="/installations/revoke"){const body=await req.json();const {installation_id,installation_secret}=body??{};if(!installation_id||!installation_secret)return reply({error:{code:"MISSING_FIELDS",message:"installation_id and installation_secret are required",request_id:requestId}},400,requestId);const secretHash=await sha256(String(installation_secret));const rows=await dbJson(`installations?id=eq.${encodeURIComponent(installation_id)}&installation_secret_hash=eq.${secretHash}&select=id`);if(!Array.isArray(rows)||rows.length!==1)return reply({error:{code:"INVALID_INSTALLATION_CREDENTIALS",message:"Installation credentials do not match",request_id:requestId}},401,requestId);const res=await dbFetch(`installations?id=eq.${encodeURIComponent(installation_id)}`,{method:"PATCH",headers:{Prefer:"return=minimal"},body:JSON.stringify({notifications_enabled:false,firebase_token:"REVOKED",revoked_at:new Date().toISOString(),updated_at:new Date().toISOString()})});if(!res.ok)throw new Error(`INSTALLATION_REVOKE_${res.status}`);return reply({success:true,revoked_at:new Date().toISOString()},200,requestId);}
    return reply({error:{code:"NOT_FOUND",message:"Route not found",request_id:requestId}},404,requestId);
  } catch (error) {
    console.error("quran-yutla-api", requestId, error instanceof Error ? error.message : "unknown_error");
    return reply({ error: { code: "INTERNAL_ERROR", message: "Request could not be completed", request_id: requestId } }, 500, requestId);
  }
});
