// ShagunBook REHEARSAL server — zero dependencies (Node 20+ built-ins only).
// MOCK mode (no keys): Sarvam + Flagsmith are simulated so you can learn the flow offline.
// REAL mode: set SARVAM_API_KEY and FLAGSMITH_SERVER_KEY in the environment.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const PORT = process.env.PORT || 8080;
const DB = process.env.DB_PATH || "./data.json";
const SARVAM_KEY = process.env.SARVAM_API_KEY || "";
const FLAG_KEY = process.env.FLAGSMITH_SERVER_KEY || "";
const MOCK_SARVAM = !SARVAM_KEY;
const MOCK_FLAGS = !FLAG_KEY;
const stats = { requests: 0, errors: 0, ab: { A: { saves: 0, edits: 0 }, B: { saves: 0, undos: 0 } } };

// ---------- storage ----------
const load = () => (fs.existsSync(DB) ? JSON.parse(fs.readFileSync(DB, "utf8")) : { shagun: [], vendors: [] });
const save = (d) => fs.writeFileSync(DB, JSON.stringify(d, null, 2));

// ---------- Flagsmith ----------
async function flagsFor(userId = "anon", role = "Friend") {
  if (MOCK_FLAGS) {
    const cfg = JSON.parse(fs.readFileSync("./flags.local.json", "utf8"));
    const f = { ...cfg.defaults, ...(cfg.segments[role] || {}) };
    // deterministic 50/50 A/B split per user, like a Flagsmith multivariate flag
    if (!cfg.segments[role]?.confirm_flow_variant) {
      f.confirm_flow_variant = parseInt(crypto.createHash("md5").update(userId).digest("hex").slice(0, 2), 16) % 2 ? "B" : "A";
    }
    return f;
  }
  // REAL: Flagsmith REST identities endpoint (identity + traits -> evaluated flags incl. segments)
  const r = await fetch("https://edge.api.flagsmith.com/api/v1/identities/", {
    method: "POST",
    headers: { "X-Environment-Key": FLAG_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: userId, traits: [{ trait_key: "role", trait_value: role }] }),
  });
  if (!r.ok) throw new Error("Flagsmith " + r.status);
  const { flags } = await r.json();
  const get = (n) => flags.find((x) => x.feature.name === n);
  const on = (n) => !!get(n)?.enabled;
  const val = (n, d) => get(n)?.feature_state_value ?? d;
  return {
    voice_entry: on("voice_entry"), sarvam_enabled: on("sarvam_enabled"), elder_mode: on("elder_mode"),
    read_aloud_summary: on("read_aloud_summary"), default_language: val("default_language", "hi-IN"),
    confirm_flow_variant: val("confirm_flow_variant", "A"), maintenance_message: val("maintenance_message", ""),
    chaos_crash: on("chaos_crash"),
  };
}

// ---------- Sarvam ----------
const SARVAM = "https://api.sarvam.ai";
const sh = () => ({ "api-subscription-key": SARVAM_KEY });
const MOCK_PHRASES = [
  "Sharma ji Lucknow wale ne ikyavan sau cash diye",
  "Caterer ko pachas hazaar advance de diya, total do lakh",
  "Meena bua ne gyarah hazaar UPI se bheje",
  "Decorator ko pachees hazaar diye",
];
let mockIdx = 0;

async function transcribe(buf, lang) {
  if (MOCK_SARVAM) return MOCK_PHRASES[mockIdx++ % MOCK_PHRASES.length];
  const fd = new FormData();
  fd.append("file", new Blob([buf], { type: "audio/wav" }), "audio.wav");
  fd.append("model", "saaras:v4"); // verify current model name in Sarvam docs
  fd.append("language_code", lang || "hi-IN");
  const r = await fetch(`${SARVAM}/speech-to-text`, { method: "POST", headers: sh(), body: fd });
  if (!r.ok) throw new Error("STT " + r.status + " " + (await r.text()));
  return (await r.json()).transcript;
}

// Hindi number words -> digits (used by mock extractor; real mode lets the LLM do it)
const NUM = { ek: 1, do: 2, teen: 3, char: 4, paanch: 5, das: 10, gyarah: 11, ikkis: 21, pachees: 25, pachas: 50, ikyavan: 51 };
const MUL = { sau: 100, hazaar: 1000, lakh: 100000 };
function wordsToNumber(s) {
  const m = s.match(/\d[\d,]*/); if (m) return Number(m[0].replace(/,/g, ""));
  let total = 0, cur = 0;
  for (const w of s.toLowerCase().split(/\s+/)) {
    if (NUM[w] != null) cur += NUM[w];
    else if (MUL[w]) { total += (cur || 1) * MUL[w]; cur = 0; }
  }
  return total + cur;
}

async function extract(text) {
  if (MOCK_SARVAM) {
    const t = text.toLowerCase();
    const isVendor = /(ko|vendor|caterer|decorator|dj|photographer|mehendi)\b/.test(t) && /de diya|diye|paid/.test(t) && !/ne /.test(t);
    if (isVendor) {
      const [paidPart, totalPart] = t.split("total");
      const vendor = text.split(/\s+ko\s+/i)[0].trim();
      return { type: "vendor", vendor, service: vendor, paid: wordsToNumber(paidPart), totalQuote: totalPart ? wordsToNumber(totalPart) : null };
    }
    const guest = text.split(/\s+ne\s+/i)[0].replace(/\s+\S+\s+wale$/i, "").trim();
    const place = (text.match(/(\S+)\s+wale/i) || [])[1] || "";
    return { type: "shagun", guest, place, amount: wordsToNumber(t.split(" ne ")[1] || t), mode: /upi/.test(t) ? "upi" : /gift/.test(t) ? "gift" : "cash" };
  }
  const r = await fetch(`${SARVAM}/v1/chat/completions`, {
    method: "POST", headers: { ...sh(), "Authorization": `Bearer ${SARVAM_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "sarvam-105b", temperature: 0.1, max_tokens: 800, // verify current model name
      messages: [
        { role: "system", content: `Convert spoken Indian wedding ledger notes to JSON. Received from guest: {"type":"shagun","guest":"","place":"","amount":0,"mode":"cash|upi|gift"}. Paid to vendor: {"type":"vendor","vendor":"","service":"","paid":0,"totalQuote":null}. "ikyavan sau"=5100, "pachas hazaar"=50000, "do lakh"=200000. Reply ONLY JSON.` },
        { role: "user", content: text },
      ],
    }),
  });
  if (!r.ok) throw new Error("CHAT " + r.status + " " + (await r.text()));
  const out = (await r.json()).choices[0].message.content;
  return JSON.parse(out.match(/\{[\s\S]*\}/)[0]);
}

async function translate(text, target) {
  if (MOCK_SARVAM || target === "en-IN") return MOCK_SARVAM && target !== "en-IN" ? `[${target}] ${text}` : text;
  const r = await fetch(`${SARVAM}/translate`, {
    method: "POST", headers: { ...sh(), "Content-Type": "application/json" },
    body: JSON.stringify({ input: text, source_language_code: "en-IN", target_language_code: target, model: "mayura:v1" }),
  });
  if (!r.ok) return text; // fall back to English if translation fails
  return (await r.json()).translated_text;
}

async function speak(text, lang) {
  if (MOCK_SARVAM) return null; // browser falls back to speechSynthesis in mock mode
  const r = await fetch(`${SARVAM}/text-to-speech`, {
    method: "POST", headers: { ...sh(), "Content-Type": "application/json" },
    body: JSON.stringify({ text, language_code: lang, model: "bulbul:v3" }),
  });
  if (!r.ok) throw new Error("TTS " + r.status + " " + (await r.text()));
  return (await r.json()).audios[0];
}

// ---------- tiny router ----------
const readBody = (req) => new Promise((res) => { const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => res(Buffer.concat(c))); });
const json = (res, code, obj) => { res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }); res.end(JSON.stringify(obj)); };
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const q = Object.fromEntries(url.searchParams);
  try {
    if (req.method === "OPTIONS") { res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" }); return res.end(); }

    if (url.pathname === "/healthz") {
      const f = await flagsFor("system").catch(() => ({}));
      if (f.chaos_crash) { console.error("CHAOS: chaos_crash flag is ON — exiting on purpose"); process.exit(1); }
      return json(res, 200, { ok: true, mockSarvam: MOCK_SARVAM, mockFlags: MOCK_FLAGS, ...stats });
    }
    if (url.pathname === "/api/flags") return json(res, 200, await flagsFor(q.userId, q.role));

    if (url.pathname === "/api/transcribe" && req.method === "POST") {
      stats.requests++;
      const f = await flagsFor(q.userId, q.role);
      if (!f.sarvam_enabled) return json(res, 200, { fallback: true });
      const audio = await readBody(req); // raw WAV body
      return json(res, 200, { text: await transcribe(audio, q.language) });
    }
    if (url.pathname === "/api/extract" && req.method === "POST") {
      const { text } = JSON.parse(await readBody(req));
      return json(res, 200, await extract(text));
    }
    if (url.pathname === "/api/entries" && req.method === "GET") return json(res, 200, load());
    if (url.pathname === "/api/entries" && req.method === "POST") {
      const e = JSON.parse(await readBody(req));
      const d = load();
      const entry = { id: Date.now(), createdAt: new Date().toISOString(), ...e };
      if (e.variant === "A") { stats.ab.A.saves++; if (e.edited) stats.ab.A.edits++; }
      if (e.variant === "B") stats.ab.B.saves++;
      if (e.type === "vendor") {
        const v = d.vendors.find((x) => x.vendor.toLowerCase() === String(e.vendor).toLowerCase());
        if (v) { v.paid += Number(e.paid || 0); if (e.totalQuote) v.totalQuote = Number(e.totalQuote); }
        else d.vendors.push({ ...entry, paid: Number(e.paid || 0) });
      } else d.shagun.push({ ...entry, amount: Number(e.amount || 0) });
      save(d);
      return json(res, 200, entry);
    }
    if (url.pathname === "/api/entries" && req.method === "DELETE") { // Undo (variant B)
      const d = load(); d.shagun = d.shagun.filter((x) => x.id != q.id); d.vendors = d.vendors.filter((x) => x.id != q.id);
      stats.ab.B.undos++; save(d); return json(res, 200, { ok: true });
    }
    if (url.pathname === "/api/ab-stats") return json(res, 200, stats.ab);
    if (url.pathname === "/api/summary-audio" && req.method === "POST") {
      const { language = "hi-IN" } = JSON.parse(await readBody(req));
      const d = load();
      const total = d.shagun.reduce((s, x) => s + Number(x.amount || 0), 0);
      const due = d.vendors.filter((v) => v.totalQuote && v.totalQuote > v.paid).map((v) => `${v.vendor}: ${v.totalQuote - v.paid} rupees`).join(", ");
      let text = `Total shagun received is ${total} rupees from ${d.shagun.length} guests. ` + (due ? `Balance due to vendors: ${due}.` : "All vendors are paid.");
      text = await translate(text, language);
      return json(res, 200, { text, audio: await speak(text, language) });
    }

    // static frontend
    const file = path.join("public", url.pathname === "/" ? "index.html" : url.pathname);
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
      return res.end(fs.readFileSync(file));
    }
    json(res, 404, { error: "not found" });
  } catch (e) {
    stats.errors++;
    console.error("ERROR", url.pathname, e.message);
    json(res, 502, { error: e.message });
  }
});

server.listen(PORT, () => console.log(`ShagunBook on :${PORT}  sarvam=${MOCK_SARVAM ? "MOCK" : "REAL"} flags=${MOCK_FLAGS ? "MOCK(flags.local.json)" : "FLAGSMITH"}`));
