// Cloud sync for the training app — one JSON document in Upstash Redis.
//
// Setup (once, in the Vercel dashboard for this project):
//   1. Storage → Create → "Upstash for Redis" (free tier is plenty) → connect it to
//      this project. That injects KV_REST_API_URL + KV_REST_API_TOKEN
//      (older integrations use UPSTASH_REDIS_REST_URL / _TOKEN — both work).
//   2. Settings → Environment Variables → add SYNC_TOKEN = any long random string.
//   3. Redeploy. In the app: ⚙ → paste the same SYNC_TOKEN → Save & sync.
//
// Protocol: POST {data, meta} where meta[key] = ms timestamp of the last local
// edit. The server keeps, per key, whichever side edited it more recently and
// returns the merged document; the client adopts every key where the server is
// newer. So different things logged on two devices both survive.
import crypto from "node:crypto";

const DOC_KEY = "druid-workout:state";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  const secret = process.env.SYNC_TOKEN;
  if (!url || !token || !secret) return res.status(501).json({ error: "Sync not configured" });

  const given = Buffer.from(String(req.headers["x-sync-token"] || ""));
  const expected = Buffer.from(secret);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected))
    return res.status(401).json({ error: "Bad sync token" });

  const redis = async (cmd) => {
    const r = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(cmd),
    });
    const j = await r.json();
    if (!r.ok || j.error) throw new Error(j.error || `Redis HTTP ${r.status}`);
    return j.result;
  };
  const load = async () => {
    const raw = await redis(["GET", DOC_KEY]);
    return raw ? JSON.parse(raw) : { data: {}, meta: {} };
  };

  try {
    if (req.method === "GET") return res.status(200).json(await load());
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    if (!body || typeof body.data !== "object" || typeof body.meta !== "object")
      return res.status(400).json({ error: "Expected {data, meta}" });

    const cur = await load();
    const out = { data: { ...cur.data }, meta: { ...cur.meta } };
    let changed = false;
    for (const k of Object.keys(body.data)) {
      const incoming = Number(body.meta[k]) || 0;   // 0 = never edited since sync existed
      const stored = Number(cur.meta?.[k]) || 0;
      // an unstamped value only fills an empty slot; a stamped one wins if it's newer
      const take = incoming > 0 ? incoming >= stored : !(k in (cur.data || {}));
      if (take) { out.data[k] = body.data[k]; out.meta[k] = incoming || Date.now(); changed = true; }
    }
    if (changed) { out.savedAt = Date.now(); await redis(["SET", DOC_KEY, JSON.stringify(out)]); }
    return res.status(200).json(out);
  } catch (e) {
    return res.status(502).json({ error: String(e?.message || e) });
  }
}
