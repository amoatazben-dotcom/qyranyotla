import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const FIREBASE_PROJECT_ID = Deno.env.get("FIREBASE_PROJECT_ID") ?? "";
const FIREBASE_CLIENT_EMAIL = Deno.env.get("FIREBASE_CLIENT_EMAIL") ?? "";
const FIREBASE_PRIVATE_KEY = (Deno.env.get("FIREBASE_PRIVATE_KEY") ?? "").replace(/\\n/g, "\n");
const ALLOWED_ROUTES = new Set(["/", "/home", "/radio", "/quran", "/reciters", "/library", "/prayer-times", "/adhkar", "/custom-reminders"]);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json; charset=utf-8",
};

function out(data: unknown, status = 200) { return new Response(JSON.stringify(data), { status, headers: cors }); }
function b64url(bytes: Uint8Array) { return btoa(String.fromCharCode(...bytes)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,""); }
function b64urlText(s: string) { return b64url(new TextEncoder().encode(s)); }

async function importPrivateKey(pem: string) {
  const body = pem.replace(/-----BEGIN PRIVATE KEY-----/g, "").replace(/-----END PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  const raw = Uint8Array.from(atob(body), c => c.charCodeAt(0));
  return crypto.subtle.importKey("pkcs8", raw, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}

async function googleAccessToken() {
  if (!FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY) throw new Error("FIREBASE_CONFIG_MISSING");
  const now = Math.floor(Date.now()/1000);
  const header = b64urlText(JSON.stringify({ alg:"RS256", typ:"JWT" }));
  const payload = b64urlText(JSON.stringify({ iss:FIREBASE_CLIENT_EMAIL, scope:"https://www.googleapis.com/auth/firebase.messaging", aud:"https://oauth2.googleapis.com/token", iat:now, exp:now+3600 }));
  const unsigned = `${header}.${payload}`;
  const key = await importPrivateKey(FIREBASE_PRIVATE_KEY);
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned)));
  const assertion = `${unsigned}.${b64url(sig)}`;
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", { method:"POST", headers:{"Content-Type":"application/x-www-form-urlencoded"}, body:new URLSearchParams({ grant_type:"urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }) });
  if (!tokenRes.ok) throw new Error(`FIREBASE_OAUTH_${tokenRes.status}`);
  const json = await tokenRes.json();
  if (!json.access_token) throw new Error("FIREBASE_OAUTH_NO_TOKEN");
  return String(json.access_token);
}

async function db(path: string, init: RequestInit = {}, profile = "app") {
  const headers = new Headers(init.headers ?? {});
  headers.set("apikey", SERVICE_ROLE);
  headers.set("Authorization", `Bearer ${SERVICE_ROLE}`);
  headers.set("Accept-Profile", profile);
  headers.set("Content-Profile", profile);
  headers.set("Content-Type", "application/json");
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers });
}

async function authenticatedUser(auth: string) {
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers:{ apikey:SERVICE_ROLE, Authorization:`Bearer ${token}` } });
  if (!res.ok) return null;
  return await res.json();
}

async function hasNotificationPermission(userId: string) {
  const adminRes = await db(`administrators?user_id=eq.${encodeURIComponent(userId)}&is_active=eq.true&select=id`);
  if (!adminRes.ok) return false;
  const admins = await adminRes.json();
  if (!admins?.[0]?.id) return false;
  const adminId = admins[0].id;
  const rolesRes = await db(`administrator_roles?administrator_id=eq.${adminId}&select=role_id`);
  if (!rolesRes.ok) return false;
  const roles = await rolesRes.json();
  const roleIds = roles.map((r:any)=>r.role_id);
  if (roleIds.includes("super_admin") || roleIds.includes("notification_manager")) return true;
  if (!roleIds.length) return false;
  const roleFilter = roleIds.map((x:string)=>`\"${x}\"`).join(",");
  const permsRes = await db(`role_permissions?role_id=in.(${roleFilter})&permission_id=eq.notifications.write&select=permission_id`);
  if (!permsRes.ok) return false;
  const perms = await permsRes.json();
  return Array.isArray(perms) && perms.length > 0;
}

async function sendOne(accessToken:string, token:string, title:string, body:string, route:string, data:Record<string,string>) {
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(FIREBASE_PROJECT_ID)}/messages:send`, {
    method:"POST",
    headers:{ Authorization:`Bearer ${accessToken}`, "Content-Type":"application/json" },
    body:JSON.stringify({ message:{ token, notification:{title,body}, data:{...data, route}, android:{priority:"high"}, apns:{headers:{"apns-priority":"10"}} } })
  });
  const json = await res.json().catch(()=>({}));
  return { ok:res.ok, status:res.status, name:json.name ?? null, error:json.error?.status ?? json.error?.message ?? null };
}

Deno.serve(async (req:Request)=>{
  if (req.method === "OPTIONS") return new Response("ok",{headers:cors});
  if (req.method !== "POST") return out({error:"METHOD_NOT_ALLOWED"},405);
  if (!SUPABASE_URL || !SERVICE_ROLE) return out({error:"SERVER_CONFIG_MISSING"},500);

  const user = await authenticatedUser(req.headers.get("Authorization") ?? "");
  if (!user?.id) return out({error:"UNAUTHORIZED"},401);
  if (!(await hasNotificationPermission(user.id))) return out({error:"FORBIDDEN"},403);

  const payload = await req.json().catch(()=>null);
  if (!payload?.title || !payload?.body) return out({error:"TITLE_BODY_REQUIRED"},400);
  const title = String(payload.title).slice(0,120);
  const body = String(payload.body).slice(0,500);
  const route = String(payload.route ?? "/");
  if (!ALLOWED_ROUTES.has(route) && !/^\/quran\/surah\/([1-9]|[1-9][0-9]|10[0-9]|11[0-4])$/.test(route)) return out({error:"ROUTE_NOT_ALLOWED"},400);

  if (!FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY) return out({error:"FIREBASE_CONFIG_MISSING",configured:false},503);
  const targetType = payload.target_type === "device" ? "device" : "all";
  let path = "installations?notifications_enabled=eq.true&revoked_at=is.null&select=id,firebase_token&limit=500";
  if (targetType === "device") {
    if (!payload.installation_id) return out({error:"INSTALLATION_ID_REQUIRED"},400);
    path = `installations?id=eq.${encodeURIComponent(String(payload.installation_id))}&notifications_enabled=eq.true&revoked_at=is.null&select=id,firebase_token&limit=1`;
  }
  const targetsRes = await db(path);
  if (!targetsRes.ok) return out({error:"TARGET_QUERY_FAILED"},500);
  const targets = await targetsRes.json();
  if (!targets.length) return out({success:true,targeted:0,sent:0,failed:0});

  const campaignRes = await db("notification_campaigns", { method:"POST", headers:{Prefer:"return=representation"}, body:JSON.stringify({title,body,notification_type:String(payload.type??"announcement"),target_type:targetType,target:targetType==="device"?{installation_id:payload.installation_id}:{},payload:{route},status:"processing",created_by:user.id}) });
  const campaignRows = campaignRes.ok ? await campaignRes.json() : [];
  const campaignId = campaignRows?.[0]?.id ?? null;

  const accessToken = await googleAccessToken();
  let sent=0, failed=0;
  for (const t of targets) {
    const result = await sendOne(accessToken, t.firebase_token, title, body, route, { type:String(payload.type??"announcement"), campaign_id:campaignId??"" });
    if (result.ok) sent++; else failed++;
    if (campaignId) await db("notification_deliveries", {method:"POST",headers:{Prefer:"return=minimal"},body:JSON.stringify({campaign_id:campaignId,installation_id:t.id,status:result.ok?"sent":"failed",firebase_message_id:result.name,error_code:result.error,attempt_count:1,sent_at:result.ok?new Date().toISOString():null})});
  }
  if (campaignId) await db(`notification_campaigns?id=eq.${campaignId}`, {method:"PATCH",headers:{Prefer:"return=minimal"},body:JSON.stringify({status:failed===0?"completed":"failed",updated_at:new Date().toISOString()})});
  return out({success:failed===0,campaign_id:campaignId,targeted:targets.length,sent,failed});
});
