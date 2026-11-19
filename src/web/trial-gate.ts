/**
 * The gate of a private trial deployment of the site. When CANDOR_TRIAL is "1", every request, pages included,
 * needs the trial token, sent in the `x-candor-trial-token` header or kept in a cookie set from the form at
 * /trial. A trial deployment with no token set refuses everything, so a first deploy is never open. The public
 * deployment leaves CANDOR_TRIAL unset, and the gate does nothing there.
 */

export interface TrialEnv {
  CANDOR_TRIAL?: string;
  CANDOR_TRIAL_TOKEN?: string;
}

const COOKIE = "candor_trial";
const HEADER = "x-candor-trial-token";

/** Compares two strings in time that does not depend on where they first differ. */
function same(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

function cookie(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

const page = (message: string, status: number) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Candor trial</title>
<body style="font:15px system-ui,sans-serif;max-width:420px;margin:15vh auto;padding:0 16px;color:#222">
<h1 style="font-size:20px">Candor trial</h1><p>${message}</p>
<form method="post" action="/trial"><input name="token" type="password" autocomplete="off" placeholder="Trial token" style="width:100%;padding:8px;font:inherit">
<button style="margin-top:12px;padding:8px 14px;font:inherit">Open</button></form></body>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );

/** Returns a response when the request may not pass, or null when it may. */
export async function trialGate(request: Request, env: TrialEnv): Promise<Response | null> {
  if (env.CANDOR_TRIAL !== "1") return null;
  const token = env.CANDOR_TRIAL_TOKEN ?? "";
  if (token.length < 16) return new Response("This trial deployment has no token set, so it is closed.", { status: 503 });
  const path = new URL(request.url).pathname;
  if (path === "/trial" && request.method === "POST") {
    const form = await request.formData().catch(() => null);
    const given = String(form?.get("token") ?? "");
    if (!same(given, token)) return page("That token is not right.", 401);
    return new Response(null, { status: 303, headers: { location: "/workspace.html", "set-cookie": `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=604800` } });
  }
  const given = request.headers.get(HEADER) ?? cookie(request, COOKIE) ?? "";
  if (same(given, token)) return null;
  if (path.startsWith("/api/")) return new Response(JSON.stringify({ error: "This is a private trial. It needs the trial token." }), { status: 401, headers: { "content-type": "application/json" } });
  return page("This is a private trial of the Candor workspace. Enter the trial token to open it.", 401);
}
