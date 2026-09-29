// Netlify function: /api/audit
// Env vars required: ANTHROPIC_API_KEY, PAYSTACK_SECRET_KEY

const PRICE_KOBO = 1000000; // NGN 10,000

const RUBRIC = {
  headline: { who: 10, outcome: 10, keywords: 5, proof: 5, readability: 5 },
  about: { hook: 12, reader: 10, proof: 12, story: 8, cta: 10, skim: 8, voice: 5 },
};

const CRITERIA_TEXT = `Score this LinkedIn headline and About section against these criteria (integers, max in brackets):
HEADLINE
- who: clear audience and function, not just a job title [10]
- outcome: states the outcome or value the reader gets [10]
- keywords: includes terms people actually search for [5]
- proof: a differentiator or proof point [5]
- readability: the first ~60 characters carry the message, no buzzword stuffing [5]
ABOUT
- hook: the first 2-3 lines earn the "see more" click [12]
- reader: focused on the reader's problem, not a CV recitation [10]
- proof: numbers, results, named outcomes [12]
- story: a short credibility story explaining why this person [8]
- cta: a clear next step for the reader [10]
- skim: short lines, white space, no dense blocks [8]
- voice: sounds like a real person, not a press release [5]
Be strict and honest. Most profiles score 30-65. Never inflate scores.`;

async function claude(model, system, user, maxTokens) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] }),
  });
  if (!r.ok) throw new Error("AI request failed");
  const d = await r.json();
  return d.content.map((c) => c.text || "").join("");
}

function parseJSON(t) {
  return JSON.parse(t.replace(/```json|```/g, "").trim());
}

function clamp(obj, max) {
  const out = {};
  for (const k in max) out[k] = Math.max(0, Math.min(max[k], Math.round(Number(obj?.[k]) || 0)));
  return out;
}

const sum = (o, keys) => keys.reduce((a, k) => a + o[k], 0);

async function score(headline, about) {
  const system = `You are a strict LinkedIn profile auditor. ${CRITERIA_TEXT}
Return ONLY JSON: {"headline":{who,outcome,keywords,proof,readability},"about":{hook,reader,proof,story,cta,skim,voice},"verdict":"one sentence, plain English","biggest_leak":"the single biggest conversion leak in one sentence","notes":{"<criterion key as headline.who etc>":"one short sentence why"}}`;
  const raw = await claude("claude-haiku-4-5-20251001", system, `HEADLINE:\n${headline}\n\nABOUT:\n${about}`, 1200);
  const j = parseJSON(raw);
  const h = clamp(j.headline, RUBRIC.headline);
  const a = clamp(j.about, RUBRIC.about);
  const cats = {
    headline: { score: sum(h, Object.keys(h)), max: 35 },
    attraction: { score: sum(a, ["hook", "reader", "skim", "voice"]), max: 35 },
    conversion: { score: sum(a, ["proof", "story", "cta"]), max: 30 },
  };
  return { total: cats.headline.score + cats.attraction.score + cats.conversion.score, cats, verdict: j.verdict, biggest_leak: j.biggest_leak, detail: { h, a, notes: j.notes || {} } };
}

async function verifyPayment(ref) {
  if (!ref) return false;
  const r = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(ref)}`, {
    headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
  });
  const d = await r.json();
  return !!(d.status && d.data && d.data.status === "success" && d.data.amount >= PRICE_KOBO && d.data.currency === "NGN");
}

async function rewrite(headline, about, name) {
  const system = `You are a senior LinkedIn personal-branding strategist. ${CRITERIA_TEXT}
Task: give a full audit and rewrite. Rules for rewrites: first person singular throughout (never third person), simple English, short lines with white space (one to two sentences per paragraph, blank line between), keep every fact the person gave, never invent numbers or credentials (use [add your number] placeholders where proof is missing).
Return ONLY JSON: {"diagnosis":[{"criterion":"name","score":"x/max","issue":"what is wrong","fix":"what to do"}],"headline_options":["3 rewritten headlines under 220 characters"],"about_rewrite":"the full rewritten About section","quick_wins":["3 actions to do today"]}`;
  const raw = await claude("claude-sonnet-5", system, `Name: ${name}\n\nHEADLINE:\n${headline}\n\nABOUT:\n${about}`, 3500);
  return parseJSON(raw);
}

exports.handler = async (event) => {
  const H = { "content-type": "application/json" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: H, body: JSON.stringify({ error: "Method not allowed" }) };
  try {
    const { mode, headline = "", about = "", name = "", reference = "" } = JSON.parse(event.body || "{}");
    if (headline.trim().length < 5 || about.trim().length < 30) return { statusCode: 400, headers: H, body: JSON.stringify({ error: "Paste your full headline and About section." }) };
    if (headline.length > 400 || about.length > 5000) return { statusCode: 400, headers: H, body: JSON.stringify({ error: "That text is too long." }) };

    if (mode === "score") {
      const s = await score(headline, about);
      delete s.detail; // free tier: category scores only
      return { statusCode: 200, headers: H, body: JSON.stringify(s) };
    }
    if (mode === "rewrite") {
      if (!(await verifyPayment(reference))) return { statusCode: 402, headers: H, body: JSON.stringify({ error: "Payment could not be verified." }) };
      const r = await rewrite(headline, about, name);
      return { statusCode: 200, headers: H, body: JSON.stringify(r) };
    }
    return { statusCode: 400, headers: H, body: JSON.stringify({ error: "Bad request." }) };
  } catch (e) {
    return { statusCode: 500, headers: H, body: JSON.stringify({ error: "Something went wrong. Please try again." }) };
  }
};
