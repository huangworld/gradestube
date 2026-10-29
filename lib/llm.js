// Provider adapters. All return {items:[{id,score,rationale,evidence:[{quote,seg_start,seg_end}]}], overall_comment}
import { ground, tokenize } from "./grounding.js";
import { uid } from "./store.js";
import { round } from "./grade.js";

export const PROVIDERS = {
  anthropic: { label: "Anthropic", presets: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"] },
  openai: { label: "OpenAI", presets: ["gpt-5", "gpt-5-mini"] },
  gemini: { label: "Gemini", presets: ["gemini-2.5-pro", "gemini-2.5-flash"] },
  manual: { label: "Manual", presets: [] },
};

const SYSTEM = `You are an experienced, fair teaching assistant grading a student's recorded video presentation against a rubric. You only have the video's spoken transcript, not the visuals.

For every rubric item:
- Assign a score between 0 and the item's max points (half points allowed).
- Ground the score in evidence: quote the transcript VERBATIM (copy exact words, 5-40 words per quote) and give the segment index range the quote spans. Include every quote that materially supports or lowers the score (usually 1-4).
- If the transcript has no evidence for an item, return an empty evidence list and explain what was missing. If the item depends on visuals that the transcript cannot show, say so in the rationale instead of guessing low.
- Rationale: 1-3 sentences tied to the rubric's wording.
Also give a 2-4 sentence overall comment addressed to the TA (strengths, main gaps).`;

function schemaFor(itemIds) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["items", "overall_comment"],
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "score", "rationale", "evidence"],
          properties: {
            id: { type: "string", enum: itemIds },
            score: { type: "number" },
            rationale: { type: "string" },
            evidence: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["quote", "seg_start", "seg_end"],
                properties: {
                  quote: { type: "string" },
                  seg_start: { type: "integer" },
                  seg_end: { type: "integer" },
                },
              },
            },
          },
        },
      },
      overall_comment: { type: "string" },
    },
  };
}

function userPrompt(rubric, transcript, info) {
  const items = rubric.items.map(it => ({ id: it.id, title: it.title, max_points: it.maxPoints, description: it.description }));
  const lines = transcript.map((s, i) => `[${i}|${s.ts}] ${s.text}`).join("\n");
  return `<rubric_source>\n${rubric.rawText || ""}\n</rubric_source>

<rubric_items>\n${JSON.stringify(items, null, 2)}\n</rubric_items>

<video title=${JSON.stringify(info.title || "")}>
Transcript lines are formatted [segment_index|timestamp] text.
${lines}
</video>

Grade every rubric item (use the ids from rubric_items).`;
}

async function httpJson(url, opts) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (!res.ok) {
    const msg = body?.error?.message || body?.error || body?.raw || res.statusText;
    const e = new Error(`${res.status}: ${typeof msg === "string" ? msg : JSON.stringify(msg)}`);
    e.status = res.status;
    throw e;
  }
  return body;
}

// ---------------- Anthropic ----------------
const anthHeaders = key => ({
  "content-type": "application/json",
  "x-api-key": key,
  "anthropic-version": "2026-10-21",
  "anthropic-dangerous-direct-browser-access": "true",
});
const supportsEffort = m => /claude-(fable|mythos|opus|sonnet|haiku)-5|claude-opus-4-[5-8]|claude-sonnet-4-6/.test(m);
const supportsFallback = m => /^claude-(fable-5-1|opus-5-5|opus-5|sonnet-5-5)$/.test(m);

async function callAnthropic({ key, model, system, user, schema }) {
  const body = {
    model, max_tokens: 16000, system,
    messages: [{ role: "user", content: user }],
    output_config: { format: { type: "json_schema", schema }, ...(supportsEffort(model) ? { effort: "high" } : {}) },
  };
  const headers = anthHeaders(key);
  let data;
  if (supportsFallback(model)) {
    try {
      data = await httpJson("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { ...headers, "anthropic-beta": "server-side-fallback-2026-07-01" },
        body: JSON.stringify({ ...body, fallbacks: "default" }),
      });
    } catch (e) {
      if (e.status !== 400 || !/fallback|beta/i.test(e.message)) throw e;
    }
  }
  if (!data) data = await httpJson("https://api.anthropic.com/v1/messages", { method: "POST", headers, body: JSON.stringify(body) });
  if (data.stop_reason === "refusal") throw new Error(`Model declined (${data.stop_details?.category || "refusal"})`);
  if (data.stop_reason === "max_tokens") throw new Error("Output hit max_tokens; try a model with more output or a shorter rubric.");
  const text = data.content.filter(b => b.type === "text").map(b => b.text).join("");
  return JSON.parse(text);
}

// ---------------- OpenAI ----------------
async function callOpenAI({ key, model, system, user, schema }) {
  const data = await httpJson("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      response_format: { type: "json_schema", json_schema: { name: "rubric_grades", strict: true, schema } },
    }),
  });
  const msg = data.choices?.[0]?.message;
  if (msg?.refusal) throw new Error(`Model declined: ${msg.refusal}`);
  return JSON.parse(msg.content);
}

// ---------------- Gemini ----------------
function toGeminiSchema(s) {
  if (Array.isArray(s)) return s.map(toGeminiSchema);
  if (!s || typeof s !== "object") return s;
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === "additionalProperties") continue;
    if (k === "type") out.type = String(v).toUpperCase();
    else if (k === "properties") out.properties = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, toGeminiSchema(pv)]));
    else out[k] = toGeminiSchema(v);
  }
  return out;
}
async function callGemini({ key, model, system, user, schema }) {
  const data = await httpJson(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: { responseMimeType: "application/json", responseSchema: toGeminiSchema(schema) },
    }),
  });
  const cand = data.candidates?.[0];
  if (!cand) throw new Error(`No response (${data.promptFeedback?.blockReason || "unknown"})`);
  return JSON.parse((cand.content?.parts || []).map(p => p.text || "").join(""));
}

const CALLERS = { anthropic: callAnthropic, openai: callOpenAI, gemini: callGemini };

// Grade one transcript. Returns a run object ready to push onto grade.runs.
export async function gradeTranscript({ provider, model, keys, rubric, transcript, info }) {
  if (!CALLERS[provider]) throw new Error(`Provider "${provider}" can't auto-grade`);
  const key = keys[provider];
  if (!key) throw new Error(`No ${PROVIDERS[provider].label} API key. Add it in Settings.`);
  if (!rubric?.items?.length) throw new Error("Active homework has no rubric.");
  if (!transcript?.length) throw new Error("No transcript.");
  const out = await CALLERS[provider]({
    key, model, system: SYSTEM, user: userPrompt(rubric, transcript, info), schema: schemaFor(rubric.items.map(i => i.id)),
  });
  const toks = tokenize(transcript);
  const items = rubric.items.map(it => {
    const r = (out.items || []).find(x => x.id === it.id);
    if (!r) return { id: it.id, score: null, rationale: "(model returned no grade for this item)", snippets: [] };
    let score = Number(r.score);
    if (isNaN(score)) score = null;
    else if (it.maxPoints != null) score = Math.min(Math.max(0, score), Number(it.maxPoints));
    return {
      id: it.id, score: score == null ? null : round(score), rationale: r.rationale || "",
      snippets: (r.evidence || []).map(ev => ground(ev, transcript, toks)),
    };
  });
  return { id: uid(), provider, model, at: Date.now(), items, comment: out.overall_comment || "" };
}

// ---------------- list models ----------------
export async function listModels(provider, key) {
  if (!key) throw new Error("No API key");
  if (provider === "anthropic") {
    const d = await httpJson("https://api.anthropic.com/v1/models?limit=100", { headers: anthHeaders(key) });
    return d.data.map(m => m.id);
  }
  if (provider === "openai") {
    const d = await httpJson("https://api.openai.com/v1/models", { headers: { authorization: `Bearer ${key}` } });
    return d.data.map(m => m.id)
      .filter(id => /^(gpt|o\d|chatgpt)/.test(id) && !/audio|realtime|transcribe|tts|image|search|embedding|instruct|moderation/.test(id))
      .sort().reverse();
  }
  if (provider === "gemini") {
    const d = await httpJson("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", { headers: { "x-goog-api-key": key } });
    return (d.models || []).filter(m => (m.supportedGenerationMethods || []).includes("generateContent"))
      .map(m => m.name.replace(/^models\//, "")).filter(id => /gemini/.test(id)).reverse();
  }
  return [];
}
