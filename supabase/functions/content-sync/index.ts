import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type,x-sync-token",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
  "Content-Type": "application/json; charset=utf-8",
};

function out(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: cors });
}

function chunk<T>(arr:T[], size:number) {
  const out:T[][]=[];
  for(let i=0;i<arr.length;i+=size) out.push(arr.slice(i,i+size));
  return out;
}

async function sha256Hex(text:string) {
  const dig = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(dig).map(b=>b.toString(16).padStart(2,"0")).join("");
}

async function fetchJson(url:string, timeoutMs=30000, retries=2):Promise<any> {
  let last:any;
  for(let attempt=0; attempt<=retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(()=>ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent":"QuranYutla/1.0 content-sync" } });
      if (!res.ok) throw new Error(`HTTP_${res.status}_${url}`);
      return await res.json();
    } catch (e) {
      last = e;
      if (attempt < retries) await new Promise(r=>setTimeout(r, 800 * (2 ** attempt) + Math.floor(Math.random()*250)));
    } finally { clearTimeout(timer); }
  }
  throw last;
}

async function db(path:string, init:RequestInit={}, profile="app") {
  if (!SUPABASE_URL || !SERVICE_ROLE) throw new Error("SUPABASE_SERVER_CONFIG_MISSING");
  const headers = new Headers(init.headers ?? {});
  headers.set("apikey", SERVICE_ROLE);
  headers.set("Authorization", `Bearer ${SERVICE_ROLE}`);
  headers.set("Accept-Profile", profile);
  headers.set("Content-Profile", profile);
  if (!headers.has("Content-Type")) headers.set("Content-Type","application/json");
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers });
}

async function dbJson(path:string, profile="app") {
  const r = await db(path, {}, profile);
  if (!r.ok) throw new Error(`DB_GET_${r.status}_${await r.text()}`);
  return await r.json();
}

async function upsert(table:string, rows:any[], conflict:string, size=250) {
  let total=0;
  for (const part of chunk(rows,size)) {
    const r = await db(`${table}?on_conflict=${encodeURIComponent(conflict)}`, {
      method:"POST",
      headers:{ Prefer:"resolution=merge-duplicates,return=minimal" },
      body:JSON.stringify(part)
    });
    if (!r.ok) throw new Error(`DB_UPSERT_${table}_${r.status}_${await r.text()}`);
    total += part.length;
  }
  return total;
}

async function insertRows(table:string, rows:any[], size=250) {
  let total=0;
  for (const part of chunk(rows,size)) {
    const r = await db(table, { method:"POST", headers:{Prefer:"return=minimal"}, body:JSON.stringify(part) });
    if (!r.ok) throw new Error(`DB_INSERT_${table}_${r.status}_${await r.text()}`);
    total += part.length;
  }
  return total;
}

async function patchSource(id:string, metadata:any={}) {
  const r = await db(`content_sources?id=eq.${encodeURIComponent(id)}`, { method:"PATCH", headers:{Prefer:"return=minimal"}, body:JSON.stringify({last_synced_at:new Date().toISOString(), metadata}) });
  if (!r.ok) throw new Error(`SOURCE_PATCH_${id}_${r.status}_${await r.text()}`);
}

async function authorize(req:Request) {
  const token = req.headers.get("x-sync-token") ?? "";
  if (!token) return false;
  const got = await sha256Hex(token);
  const rows = await dbJson(`app_config?key=eq._content_sync_token_hash&select=value&limit=1`);
  const expected = rows?.[0]?.value;
  return typeof expected === "string" && expected.length === 64 && expected === got;
}

function normalizeSajda(v:any) {
  if (v === true) return true;
  if (v && typeof v === "object") return true;
  return false;
}

async function syncQuran() {
  const [uth,taj,simple] = await Promise.all([
    fetchJson("https://api.alquran.cloud/v1/quran/quran-uthmani",45000,2),
    fetchJson("https://api.alquran.cloud/v1/quran/quran-tajweed",45000,2),
    fetchJson("https://api.alquran.cloud/v1/quran/quran-simple-clean",45000,2),
  ]);
  const uthSurahs = uth?.data?.surahs;
  const tajSurahs = taj?.data?.surahs;
  const simpleSurahs = simple?.data?.surahs;
  if (!Array.isArray(uthSurahs) || !Array.isArray(tajSurahs) || !Array.isArray(simpleSurahs)) throw new Error("QURAN_SOURCE_SHAPE_INVALID");
  if (uthSurahs.length !== 114 || tajSurahs.length !== 114 || simpleSurahs.length !== 114) throw new Error("QURAN_SURAH_COUNT_MISMATCH");
  const uthAyahs = uthSurahs.flatMap((s:any)=>s.ayahs ?? []);
  const tajAyahs = tajSurahs.flatMap((s:any)=>s.ayahs ?? []);
  const simpleAyahs = simpleSurahs.flatMap((s:any)=>s.ayahs ?? []);
  if (uthAyahs.length !== 6236 || tajAyahs.length !== 6236 || simpleAyahs.length !== 6236) throw new Error(`QURAN_AYAH_COUNT_MISMATCH_${uthAyahs.length}_${tajAyahs.length}_${simpleAyahs.length}`);

  const tajMap = new Map<number,string>();
  const simpleMap = new Map<number,string>();
  for (const a of tajAyahs) tajMap.set(Number(a.number), String(a.text ?? ""));
  for (const a of simpleAyahs) simpleMap.set(Number(a.number), String(a.text ?? ""));

  const surahRows:any[]=[];
  const ayahRows:any[]=[];
  const pageGroups = new Map<number, any[]>();
  for (const s of uthSurahs) {
    const ayahs = Array.isArray(s.ayahs)?s.ayahs:[];
    const pages = ayahs.map((a:any)=>Number(a.page)).filter((n:number)=>n>=1&&n<=604);
    surahRows.push({
      number:Number(s.number),
      name_ar:String(s.name ?? ""),
      name_en:String(s.englishName ?? ""),
      transliteration:String(s.englishName ?? ""),
      revelation_type:String(s.revelationType ?? "").toLowerCase()==="medinan"?"medinan":"meccan",
      ayah_count:Number(s.numberOfAyahs ?? ayahs.length),
      page_start:Math.min(...pages),
      page_end:Math.max(...pages),
    });
    for (const a of ayahs) {
      const global = Number(a.number);
      const surahNumber = Number(s.number);
      const ayahNumber = Number(a.numberInSurah);
      const page = Number(a.page);
      const row = {
        surah_number:surahNumber,
        ayah_number:ayahNumber,
        verse_key:`${surahNumber}:${ayahNumber}`,
        page_number:page,
        juz_number:Number(a.juz),
        hizb_number:Math.ceil(Number(a.hizbQuarter ?? 0)/4) || null,
        rub_number:Number(a.hizbQuarter ?? 0) || null,
        ruku_number:Number(a.ruku ?? 0) || null,
        sajdah:normalizeSajda(a.sajda),
        text_uthmani:String(a.text ?? ""),
        text_imlaei_simple:simpleMap.get(global) ?? null,
        text_tajweed:tajMap.get(global) ?? null,
      };
      ayahRows.push(row);
      if (!pageGroups.has(page)) pageGroups.set(page,[]);
      pageGroups.get(page)!.push(row);
    }
  }
  if (surahRows.some(s=>!Number.isFinite(s.page_start)||!Number.isFinite(s.page_end))) throw new Error("QURAN_PAGE_METADATA_INVALID");
  await upsert("quran_surahs",surahRows,"number",114);
  await upsert("quran_ayahs",ayahRows,"verse_key",220);

  const pageRows:any[]=[];
  for(let p=1;p<=604;p++) {
    const verses=(pageGroups.get(p)??[]).sort((a,b)=>a.surah_number-b.surah_number||a.ayah_number-b.ayah_number);
    if (!verses.length) throw new Error(`QURAN_EMPTY_PAGE_${p}`);
    const hash=await sha256Hex(verses.map(v=>`${v.verse_key}|${v.text_uthmani}`).join("\n"));
    pageRows.push({page_number:p,edition:"madinah_hafs_text",asset_path:`dynamic://quran/page/${p}?edition=madinah-hafs-text`,sha256:hash,width:null,height:null,manifest_version:"alqurancloud-uthmani-2026-09"});
  }
  await upsert("quran_pages",pageRows,"page_number,edition",100);

  const total = await dbJson("quran_ayahs?select=id", "app");
  if (total.length !== 6236) {
    const countRes = await db("quran_ayahs?select=id", {headers:{Prefer:"count=exact",Range:"0-0"}}, "app");
    const cr = countRes.headers.get("content-range") ?? "";
    if (!cr.endsWith("/6236")) throw new Error(`QURAN_DB_COUNT_VERIFY_FAILED_${cr}`);
  }
  await patchSource("alquran_cloud", {quran_text:true,tajweed:true,simple_clean:true,last_quran_sync:new Date().toISOString(),canonical_counts:{surahs:114,ayahs:6236,pages:604}});
  return {surahs:114,ayahs:6236,pages:604};
}

async function syncThematic() {
  const surahs = await dbJson("quran_surahs?select=number,ayah_count&order=number.asc");
  if (!Array.isArray(surahs) || surahs.length !== 114) throw new Error("IMPORT_QURAN_FIRST");
  const maxMap = new Map<number,number>(surahs.map((s:any)=>[Number(s.number),Number(s.ayah_count)]));
  const src = await fetchJson("https://cdn.jsdelivr.net/gh/mohammed-2-5/islamic-library-data@master/quran/quran_segments.json",30000,2);
  if (Number(src?.total_surahs)!==114 || !Array.isArray(src?.categories) || !Array.isArray(src?.surahs)) throw new Error("THEMATIC_SOURCE_SHAPE_INVALID");
  const categories = src.categories.map((c:any,i:number)=>({id:String(c.id),name_ar:String(c.name_ar),color_hex:String(c.color),sort_order:i+1,source_id:"islamic_library_data",metadata:{source_version:src.version??null}}));
  await upsert("quran_theme_categories",categories,"id",50);
  const rows:any[]=[];
  for(const s of src.surahs) {
    const sn=Number(s.surah_number); const max=maxMap.get(sn);
    if(!max) throw new Error(`THEMATIC_UNKNOWN_SURAH_${sn}`);
    for(const seg of (s.segments??[])) {
      const start=Number(seg.start), end=Number(seg.end);
      if(start<1||end<start||end>max) throw new Error(`THEMATIC_RANGE_INVALID_${sn}_${start}_${end}_${max}`);
      rows.push({surah_number:sn,start_ayah:start,end_ayah:end,theme_ar:String(seg.theme??""),description_ar:String(seg.description??""),category_id:String(seg.category??""),color_hex:String(seg.color??"#E8F5E9"),source_id:"islamic_library_data",source_ref:"quran/quran_segments.json",review_status:"source_unreviewed"});
    }
  }
  if (rows.length !== 745) throw new Error(`THEMATIC_SEGMENT_COUNT_MISMATCH_${rows.length}`);
  const del = await db("quran_thematic_segments?source_id=eq.islamic_library_data",{method:"DELETE",headers:{Prefer:"return=minimal"}});
  if(!del.ok) throw new Error(`THEMATIC_DELETE_${del.status}_${await del.text()}`);
  await insertRows("quran_thematic_segments",rows,200);
  await patchSource("islamic_library_data",{thematic_segments:745,thematic_categories:categories.length,last_thematic_sync:new Date().toISOString(),review_status:"community_source_not_canonical"});
  return {categories:categories.length,segments:rows.length};
}

function riwayahFromName(name:string) {
  const n=name.replace(/\s+/g," ");
  if(n.includes("حفص")) return "حفص عن عاصم";
  if(n.includes("ورش")) return "ورش عن نافع";
  if(n.includes("قالون")) return "قالون عن نافع";
  if(n.includes("شعبة")) return "شعبة عن عاصم";
  if(n.includes("الدوري")) return "الدوري";
  return "كما في المصدر";
}
function pad3(n:number){return String(n).padStart(3,"0");}
function fmt(url:string){ if(/\.m3u8(\?|$)/i.test(url)) return "hls"; if(/\.mp3(\?|$)/i.test(url)) return "mp3"; if(/\.aac/i.test(url)) return "aac"; return "stream"; }

async function syncMp3Quran() {
  const [recJ,radJ,tvJ,vidJ,tafJ] = await Promise.all([
    fetchJson("https://www.mp3quran.net/api/v3/reciters?language=ar",30000,2),
    fetchJson("https://www.mp3quran.net/api/v3/radios?language=ar",30000,2),
    fetchJson("https://www.mp3quran.net/api/v3/live-tv?language=ar",30000,2),
    fetchJson("https://www.mp3quran.net/api/v3/videos?language=ar",30000,2),
    fetchJson("https://www.mp3quran.net/api/v3/tafasir?language=ar",30000,2),
  ]);
  const reciters=Array.isArray(recJ?.reciters)?recJ.reciters:[];
  const radios=Array.isArray(radJ?.radios)?radJ.radios:[];
  const livetv=Array.isArray(tvJ?.livetv)?tvJ.livetv:[];
  const videos=Array.isArray(vidJ?.videos)?vidJ.videos:[];
  const tafasir=Array.isArray(tafJ?.tafasir)?tafJ.tafasir:[];
  if(!reciters.length) throw new Error("MP3QURAN_RECITERS_EMPTY");

  const reciterRows=reciters.map((r:any)=>({slug:`mp3quran-${r.id}`,name_ar:String(r.name??`قارئ ${r.id}`),name_en:null,canonical_name:String(r.name??`MP3Quran ${r.id}`),country:null,bio_ar:null,bio_en:null,image_url:null,is_featured:false,is_active:true}));
  await upsert("reciters",reciterRows,"slug",200);
  const ids=await dbJson("reciters?slug=like.mp3quran-*&select=id,slug");
  const idMap=new Map<string,string>(ids.map((x:any)=>[String(x.slug),String(x.id)]));
  const mappings:any[]=[]; const tracks:any[]=[];
  for(const r of reciters) {
    const rid=idMap.get(`mp3quran-${r.id}`); if(!rid) continue;
    for(const m of (r.moshaf??[])) {
      const ext=`mp3quran:${r.id}:${m.id}`;
      const list=String(m.surah_list??"").split(",").map((x:string)=>Number(x)).filter((n:number)=>n>=1&&n<=114);
      mappings.push({reciter_id:rid,provider_id:"mp3quran",provider_reciter_id:String(r.id),riwayah:riwayahFromName(String(m.name??"")),moshaf:String(m.name??"مصحف"),bitrate:192,metadata:{mp3quran_moshaf_id:m.id,server:m.server,surah_total:m.surah_total,moshaf_type:m.moshaf_type,surah_list:list},is_active:true,external_key:ext,stream_allowed:true,download_allowed:false,audio_url_template:`${String(m.server??"").replace(/\/+$/,"/")}{surah_3}.mp3`,rights_note:"Streaming URL published by MP3Quran developer API; offline download disabled until source-specific permission is documented."});
      for(const s of list) tracks.push({reciter_id:rid,provider_id:"mp3quran",surah_number:s,ayah_number:null,bitrate:192,audio_url:`${String(m.server??"").replace(/\/+$/,"/")}${pad3(s)}.mp3`,duration_seconds:0,sha256:null,metadata:{mp3quran_reciter_id:r.id,mp3quran_moshaf_id:m.id,moshaf_name:m.name},is_active:true,external_key:`${ext}:surah:${s}`,track_kind:"surah",download_allowed:false,rights_note:"Direct source URL from MP3Quran API; stream-only policy in Quran Yutla unless explicit download permission is added."});
    }
  }
  await upsert("reciter_provider_mappings",mappings,"external_key",200);
  await upsert("quran_audio_tracks",tracks,"external_key",220);

  const stationRows=radios.filter((x:any)=>x?.url).map((r:any)=>({slug:`mp3quran-radio-${r.id}`,name_ar:String(r.name??`إذاعة ${r.id}`),name_en:null,description:"إذاعة من دليل MP3Quran",logo_url:null,stream_url:String(r.url),fallback_stream_url:null,category_id:null,source_type:"external",provider_name:"MP3Quran.net",country:null,bitrate_kbps:null,is_featured:false,is_playable:true,is_active:true,rights_note:"Live stream discovered through MP3Quran developer API. Recording/download disabled unless the station grants it explicitly.",health_status:"unknown",source_id:"mp3quran",external_id:String(r.id),media_kind:"audio",stream_format:fmt(String(r.url)),stream_allowed:true,download_allowed:false,record_allowed:false,timeshift_allowed:false,terms_url:"https://www.mp3quran.net/ar/api",recording_note:"استماع مباشر فقط حتى وجود إذن صريح بالتسجيل."}));
  await upsert("stations",stationRows,"slug",180);
  const stationIds=await dbJson("stations?source_id=eq.mp3quran&select=id,external_id,stream_url,stream_format");
  const candidates=stationIds.map((s:any)=>({station_id:s.id,stream_url:s.stream_url,priority:10,source_id:"mp3quran",stream_format:s.stream_format,is_active:true,health_status:"unknown",failure_streak:0}));
  await upsert("station_stream_candidates",candidates,"station_id,stream_url",180);

  const tvRows=livetv.filter((x:any)=>x?.url).map((x:any)=>({source_id:"mp3quran",external_id:String(x.id),name_ar:String(x.name??`قناة ${x.id}`),name_en:null,channel_type:"live_tv",stream_url:String(x.url),fallback_stream_url:null,thumbnail_url:null,stream_format:fmt(String(x.url)),stream_allowed:true,download_allowed:false,record_allowed:false,timeshift_allowed:false,terms_url:"https://www.mp3quran.net/ar/api",rights_note:"Live TV URL published through MP3Quran API; playback enabled, recording/download disabled by default.",is_active:true,health_status:"unknown",failure_streak:0}));
  await upsert("live_channels",tvRows,"source_id,external_id",50);

  const videoRows:any[]=[];
  for(const group of videos) for(const v of (group.videos??[])) if(v?.video_url) videoRows.push({source_id:"mp3quran",external_id:`${group.id}-${v.id}`,reciter_name:String(group.reciter_name??""),title_ar:`تلاوة مرئية — ${String(group.reciter_name??"")}`,video_url:String(v.video_url),thumbnail_url:v.video_thumb_url?String(v.video_thumb_url):null,video_type:String(v.video_type??"video"),stream_allowed:true,download_allowed:false,rights_note:"Video URL published through MP3Quran API; streaming enabled and download disabled unless explicit rights are documented.",is_active:true});
  await upsert("video_items",videoRows,"source_id,external_id",100);

  const tafRows=tafasir.filter((x:any)=>x?.url).map((x:any)=>({source_id:"mp3quran",external_id:String(x.id),name_ar:String(x.name??`تفسير ${x.id}`),api_url:String(x.url),media_type:"audio",download_allowed:false,rights_note:"Catalog endpoint published by MP3Quran. Individual usage rights follow the source.",is_active:true}));
  await upsert("tafsir_sources",tafRows,"source_id,external_id",100);

  await patchSource("mp3quran",{reciters:reciters.length,reciter_mappings:mappings.length,surah_tracks:tracks.length,radios:stationRows.length,live_tv:tvRows.length,videos:videoRows.length,tafasir:tafRows.length,last_sync:new Date().toISOString()});
  return {reciters:reciters.length,mappings:mappings.length,tracks:tracks.length,radios:stationRows.length,live_tv:tvRows.length,videos:videoRows.length,tafasir:tafRows.length};
}

async function syncAlquranAudio() {
  const j=await fetchJson("https://api.alquran.cloud/v1/edition/format/audio",30000,2);
  const editions=Array.isArray(j?.data)?j.data.filter((e:any)=>String(e.language??"")==="ar"):[];
  if(!editions.length) throw new Error("ALQURAN_AUDIO_EDITIONS_EMPTY");
  const recRows=editions.map((e:any)=>({slug:`alquran-${String(e.identifier).replace(/[^a-zA-Z0-9._-]/g,"-")}`,name_ar:String(e.name??e.englishName??e.identifier),name_en:String(e.englishName??""),canonical_name:String(e.name??e.englishName??e.identifier),country:null,bio_ar:null,bio_en:null,image_url:null,is_featured:false,is_active:true}));
  await upsert("reciters",recRows,"slug",150);
  const ids=await dbJson("reciters?slug=like.alquran-*&select=id,slug");
  const idMap=new Map<string,string>(ids.map((x:any)=>[String(x.slug),String(x.id)]));
  const mappings:any[]=[];
  for(const e of editions){
    const slug=`alquran-${String(e.identifier).replace(/[^a-zA-Z0-9._-]/g,"-")}`; const rid=idMap.get(slug); if(!rid) continue;
    mappings.push({reciter_id:rid,provider_id:"alquran_cloud",provider_reciter_id:String(e.identifier),riwayah:"كما في المصدر",moshaf:String(e.type??"versebyverse"),bitrate:128,metadata:{identifier:e.identifier,language:e.language,format:e.format,type:e.type,direction:e.direction,english_name:e.englishName,bitrate_note:"Resolve supported bitrate from Islamic Network CDN info before playback"},is_active:true,external_key:`alquran:${e.identifier}`,stream_allowed:true,download_allowed:true,audio_url_template:`https://cdn.islamic.network/quran/audio/{bitrate}/${e.identifier}/{global_ayah}.mp3`,rights_note:"Al Quran Cloud terms permit streaming, embedding and personal/educational downloading of published recitations; copyright remains with reciters/estates."});
  }
  await upsert("reciter_provider_mappings",mappings,"external_key",160);
  await patchSource("alquran_cloud",{audio_editions_ar:editions.length,audio_mappings:mappings.length,last_audio_sync:new Date().toISOString(),audio_rights:"stream/embed/download personal-educational per source terms"});
  return {audio_editions_ar:editions.length,mappings:mappings.length};
}

Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS") return new Response("ok",{headers:cors});
  if(req.method!=="POST") return out({error:"METHOD_NOT_ALLOWED"},405);
  try {
    if(!(await authorize(req))) return out({error:"UNAUTHORIZED_SYNC"},401);
    const body=await req.json().catch(()=>({}));
    const action=String(body?.action??"all");
    const result:any={};
    if(action==="quran"||action==="all") result.quran=await syncQuran();
    if(action==="thematic"||action==="all") result.thematic=await syncThematic();
    if(action==="mp3quran"||action==="all") result.mp3quran=await syncMp3Quran();
    if(action==="alquran_audio"||action==="all") result.alquran_audio=await syncAlquranAudio();
    if(!["quran","thematic","mp3quran","alquran_audio","all"].includes(action)) return out({error:"UNKNOWN_ACTION"},400);
    return out({success:true,action,result,finished_at:new Date().toISOString()});
  } catch(e) {
    console.error(e);
    return out({success:false,error:String((e as any)?.message??e)},500);
  }
});
