import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const projectId = Deno.env.get("FIREBASE_PROJECT_ID") ?? "";
const clientEmail = Deno.env.get("FIREBASE_CLIENT_EMAIL") ?? "";
const privateKey = (Deno.env.get("FIREBASE_PRIVATE_KEY") ?? "").replace(/\\n/g, "\n");

function b64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function b64urlText(s: string) { return b64url(new TextEncoder().encode(s)); }

async function importPrivateKey(pem: string) {
  const body = pem.replace(/-----BEGIN PRIVATE KEY-----/g, "").replace(/-----END PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  const raw = Uint8Array.from(atob(body), c => c.charCodeAt(0));
  return crypto.subtle.importKey("pkcs8", raw, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}

async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlText(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64urlText(JSON.stringify({
    iss: clientEmail,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  }));
  const unsigned = `${header}.${payload}`;
  const key = await importPrivateKey(privateKey);
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned)));
  const assertion = `${unsigned}.${b64url(sig)}`;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, hasAccessToken: Boolean(json.access_token), error: json.error ?? null, errorDescription: json.error_description ?? null };
}

Deno.serve(async () => {
  const configured = {
    projectId: Boolean(projectId),
    clientEmail: Boolean(clientEmail),
    privateKey: Boolean(privateKey),
  };

  if (!configured.projectId || !configured.clientEmail || !configured.privateKey) {
    return new Response(JSON.stringify({ configured, oauth: { ok: false, reason: "MISSING_FIREBASE_SECRET" } }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const oauth = await getAccessToken();
    return new Response(JSON.stringify({ configured, oauth }), {
      status: oauth.ok ? 200 : 502,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ configured, oauth: { ok: false, error: String(e) } }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
