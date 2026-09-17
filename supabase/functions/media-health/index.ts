import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const jsonHeaders = {"Content-Type":"application/json; charset=utf-8"};
function out(data:unknown,status=200){return new Response(JSON.stringify(data),{status,headers:jsonHeaders});}
async function sha256Hex(text:string){const d=new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(text)));return [...d].map(b=>b.toString(16).padStart(2,"0")).join("");}
async function db(path:string,init:RequestInit={},profile="app"){
  const h=new Headers(init.headers??{});h.set("apikey",SERVICE_ROLE);h.set("Authorization",`Bearer ${SERVICE_ROLE}`);h.set("Accept-Profile",profile);h.set("Content-Profile",profile);if(!h.has("Content-Type"))h.set("Content-Type","application/json");
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`,{...init,headers:h});
}
async function dbJson(path:string){const r=await db(path);if(!r.ok)throw new Error(`DB_${r.status}_${await r.text()}`);return r.json();}
async function authorized(req:Request){const t=req.headers.get("x-sync-token")??"";if(!t)return false;const got=await sha256Hex(t);const rows=await dbJson("app_config?key=eq._content_sync_token_hash&select=value&limit=1");return rows?.[0]?.value===got;}
async function probe(url:string,timeout=7000){
  const start=Date.now();
  const attempt=async(range:boolean)=>{
    const c=new AbortController();const timer=setTimeout(()=>c.abort(),timeout);
    try{
      const headers:Record<string,string>={"User-Agent":"QuranYutla/1.0 health"}; if(range) headers["Range"]="bytes=0-1023";
      const r=await fetch(url,{method:"GET",headers,redirect:"follow",signal:c.signal});
      if(!r.ok) return {ok:false,status:r.status,latency:Date.now()-start,error:`HTTP_${r.status}`};
      if(/\.m3u8(\?|$)/i.test(url)||String(r.headers.get("content-type")??"").includes("mpegurl")){
        const txt=await r.text();
        return {ok:txt.includes("#EXTM3U")||txt.length>0,status:r.status,latency:Date.now()-start,error:txt.length?null:"EMPTY_PLAYLIST"};
      }
      const reader=r.body?.getReader(); if(reader){const first=await reader.read();await reader.cancel().catch(()=>{});return {ok:!first.done&&!!first.value?.length,status:r.status,latency:Date.now()-start,error:first.done?"NO_BYTES":null};}
      return {ok:true,status:r.status,latency:Date.now()-start,error:null};
    }catch(e){return {ok:false,status:0,latency:Date.now()-start,error:String((e as any)?.name??e)};}finally{clearTimeout(timer);}
  };
  let x=await attempt(true); if(!x.ok && [400,403,405,416].includes(x.status)) x=await attempt(false); return x;
}
async function upsertHealth(sourceId:string,p:any){
  const body={source_id:sourceId,status:p.ok?"healthy":"offline",latency_ms:p.latency,failure_streak:p.ok?0:1,last_success_at:p.ok?new Date().toISOString():null,last_failure_at:p.ok?null:new Date().toISOString(),last_error:p.error,checked_at:new Date().toISOString()};
  const r=await db("provider_health?on_conflict=source_id",{method:"POST",headers:{Prefer:"resolution=merge-duplicates,return=minimal"},body:JSON.stringify(body)});if(!r.ok)throw new Error(`HEALTH_UPSERT_${await r.text()}`);
}
async function pool<T>(items:T[],limit:number,fn:(x:T)=>Promise<void>){let i=0;const workers=Array.from({length:Math.min(limit,items.length)},async()=>{while(true){const idx=i++;if(idx>=items.length)break;await fn(items[idx]);}});await Promise.all(workers);}
async function refreshMp3RadioUrls(){
  try{
    const r=await fetch("https://www.mp3quran.net/api/v3/radios?language=ar",{headers:{"User-Agent":"QuranYutla/1.0 health"}});if(!r.ok)return 0;const j=await r.json();const map=new Map((j.radios??[]).map((x:any)=>[String(x.id),String(x.url??"")]));
    const stations=await dbJson("stations?source_id=eq.mp3quran&select=id,external_id,stream_url");let changed=0;
    for(const s of stations){const nu=map.get(String(s.external_id));if(nu&&nu!==s.stream_url){const p=await db(`stations?id=eq.${s.id}`,{method:"PATCH",headers:{Prefer:"return=minimal"},body:JSON.stringify({stream_url:nu,updated_at:new Date().toISOString()})});if(p.ok){changed++;await db("station_stream_candidates?on_conflict=station_id,stream_url",{method:"POST",headers:{Prefer:"resolution=merge-duplicates,return=minimal"},body:JSON.stringify({station_id:s.id,stream_url:nu,priority:10,source_id:"mp3quran",stream_format:/\.m3u8/i.test(nu)?"hls":"stream",is_active:true,health_status:"unknown",failure_streak:0})});}}
    }
    return changed;
  }catch{return 0;}
}
Deno.serve(async(req:Request)=>{
  if(req.method!=="POST")return out({error:"METHOD_NOT_ALLOWED"},405);
  try{
    if(!(await authorized(req)))return out({error:"UNAUTHORIZED"},401);
    const body=await req.json().catch(()=>({}));const refresh=body?.refresh_catalog!==false;
    const providers=[
      ["alquran_cloud","https://api.alquran.cloud/v1/edition/format/audio"],
      ["mp3quran","https://www.mp3quran.net/api/v3/radios?language=ar"],
      ["islamic_library_data","https://cdn.jsdelivr.net/gh/mohammed-2-5/islamic-library-data@master/quran/quran_segments.json"],
      ["fawaz_hadith","https://cdn.jsdelivr.net/gh/fawazahmed0/hadith-api@1/editions.min.json"],
    ];
    const providerResults:any={};
    for(const [id,url] of providers){const p=await probe(url,9000);providerResults[id]=p;await upsertHealth(id,p);}
    const refreshed=refresh?await refreshMp3RadioUrls():0;
    const stations=await dbJson("stations?is_active=eq.true&is_playable=eq.true&stream_allowed=eq.true&select=id,stream_url,failure_streak");
    let healthy=0,offline=0;
    await pool(stations,16,async(s:any)=>{const p=await probe(String(s.stream_url),6500);if(p.ok)healthy++;else offline++;const streak=p.ok?0:Number(s.failure_streak??0)+1;await db(`stations?id=eq.${s.id}`,{method:"PATCH",headers:{Prefer:"return=minimal"},body:JSON.stringify({health_status:p.ok?"healthy":(streak<3?"degraded":"offline"),last_health_check_at:new Date().toISOString(),last_latency_ms:p.latency,failure_streak:streak})});await db(`station_stream_candidates?station_id=eq.${s.id}&stream_url=eq.${encodeURIComponent(String(s.stream_url))}`,{method:"PATCH",headers:{Prefer:"return=minimal"},body:JSON.stringify({health_status:p.ok?"healthy":(streak<3?"degraded":"offline"),last_health_check_at:new Date().toISOString(),last_latency_ms:p.latency,failure_streak:streak,last_error:p.error})});});
    const channels=await dbJson("live_channels?is_active=eq.true&stream_allowed=eq.true&select=id,stream_url,failure_streak");
    let videoHealthy=0,videoOffline=0;
    await pool(channels,6,async(c:any)=>{const p=await probe(String(c.stream_url),8000);if(p.ok)videoHealthy++;else videoOffline++;const streak=p.ok?0:Number(c.failure_streak??0)+1;await db(`live_channels?id=eq.${c.id}`,{method:"PATCH",headers:{Prefer:"return=minimal"},body:JSON.stringify({health_status:p.ok?"healthy":(streak<3?"degraded":"offline"),last_health_check_at:new Date().toISOString(),last_latency_ms:p.latency,failure_streak:streak})});});
    return out({success:true,providers:providerResults,radio:{checked:stations.length,healthy,offline,catalog_urls_refreshed:refreshed},live_video:{checked:channels.length,healthy:videoHealthy,offline:videoOffline},checked_at:new Date().toISOString()});
  }catch(e){console.error(e);return out({success:false,error:String((e as any)?.message??e)},500);}
});
