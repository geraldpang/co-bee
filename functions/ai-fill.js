// Cloudflare Pages Function
// Deploys automatically at:  https://<your-site>.pages.dev/ai-fill
// Requires an environment variable set in the Cloudflare dashboard:
//   Pages project → Settings → Environment Variables → ANTHROPIC_API_KEY (Encrypted)

function buildSystemPrompt() {
  // Anchor "today" to Singapore time so relative dates (e.g. "this Fri", "next Sat",
  // "tomorrow") can be resolved with confidence instead of always falling back to null.
  const nowSGT = new Date().toLocaleString('en-CA', {
    timeZone: 'Asia/Singapore',
    weekday: 'long',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  // en-CA gives "Weekday, YYYY-MM-DD" — reformat to a plain sentence for the model.
  const [weekday, isoDate] = nowSGT.split(', ');

  return `You extract group-buy event details from a host's pasted text and/or an uploaded photo (poster, menu, price list, chat message screenshot, etc.). All hosts and buyers are in Singapore.

Today is ${weekday}, ${isoDate} (Asia/Singapore, SGT). Use this to resolve relative dates ("this Fri", "next Sat", "tomorrow", "in 3 days") into absolute calendar dates. Only fall back to null if the date genuinely cannot be pinned down even with today's date known (e.g. "sometime next month").

Return ONLY valid JSON — no markdown fences, no commentary, no leading/trailing text. Match this exact shape:

{
  "title": string | null,
  "description": string | null,
  "address": string | null,
  "closingDate": "YYYY-MM-DD" | null,
  "collectionDate": "YYYY-MM-DD" | null,
  "timeFrom": "HH:MM" | null,
  "timeTo": "HH:MM" | null,
  "items": [
    {
      "name": string,
      "description": string | null,
      "price": number | null,
      "unit": string | null,
      "options": [
        { "name": string, "priceDelta": number | null, "required": boolean }
      ]
    }
  ]
}

Rules:
- Use null for any field not clearly present in the source material. Never invent a date, price, or address that isn't stated.
- "items" should be an empty array if no distinct products/items are mentioned.
- Dates: numeric dates like "3/4" or "12/5" are DAY/MONTH (Singapore convention) — never interpret them as MONTH/DAY. If a date is genuinely ambiguous even under DD/MM (e.g. "13/2" is unambiguous, but a source using an unclear format), prefer DD/MM.
- Times: 24-hour "HH:MM" in SGT. Convert phrases like "7pm" to "19:00".
- Prices: strip currency symbols and thousands separators, return as a plain number (e.g. 18.90, not "$18.90" or "S$18.90").
- "unit" captures what the price is per, when the source states it (e.g. "per case (10 packs)", "per kg", "per pack of 3"). Use null if the source just gives a single flat price with no unit stated.
- "options" captures variant choices with their own naming and price difference from the base item price (e.g. a menu listing "Small $8 / Large $12" for one item → base item price 8.00, then one option {"name": "Large", "priceDelta": 4, "required": false}). Mark an option "required": true only if the source clearly states buyers must choose one (e.g. "please select a size"). Use an empty array if no variants are mentioned.
- If the source is a screenshot of a chat conversation, focus on the single message that actually describes the group buy, not surrounding chatter.
- If the pasted text or photo clearly contains more than one unrelated group buy (different hosts, different unrelated products with no shared closing/collection details), extract only the most complete and clearly-described one. Do not merge items from unrelated group buys into a single event.

Example — input text: "Chestnuts group buy! Closing this Sat, collect next Tue 6-8pm at Blk 22 void deck. $10/pack or $85 for a case of 10 packs."
Example output:
{"title":"Chestnuts Group Buy","description":null,"address":"Blk 22 void deck","closingDate":"<the resolved Saturday date>","collectionDate":"<the resolved Tuesday date>","timeFrom":"18:00","timeTo":"20:00","items":[{"name":"Chestnuts","description":null,"price":10,"unit":"per pack","options":[{"name":"Case (10 packs)","priceDelta":75,"required":false}]}]}`;
}

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return Response.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  const { text, imageBase64, imageMediaType } = body || {};

  if (!text && !imageBase64) {
    return Response.json({ error: 'Provide text or an image to extract from.' }, { status: 400 });
  }

  const content = [];
  if (text) {
    content.push({ type: 'text', text: text.slice(0, 8000) }); // basic length guard
  }
  if (imageBase64) {
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: imageMediaType || 'image/jpeg',
        data: imageBase64
      }
    });
  }

  if (!env.ANTHROPIC_API_KEY) {
    return Response.json({ error: 'Server is not configured with an API key.' }, { status: 500 });
  }

  let claudeRes;
  try {
    claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1500,
        system: buildSystemPrompt(),
        messages: [{ role: 'user', content }]
      })
    });
  } catch (e) {
    return Response.json({ error: 'Could not reach the AI service. Please try again.' }, { status: 502 });
  }

  if (!claudeRes.ok) {
    const errText = await claudeRes.text().catch(() => '');
    return Response.json(
      { error: 'AI service returned an error.', detail: errText.slice(0, 300) },
      { status: 502 }
    );
  }

  const data = await claudeRes.json();

  // Claude's response text should be pure JSON per the system prompt — parse it server-side
  // so the client always gets a clean, predictable shape (or a clear error) either way.
  const rawText = (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();

  let extracted;
  try {
    const cleaned = rawText.replace(/^```json\s*|^```\s*|```\s*$/g, '').trim();
    extracted = JSON.parse(cleaned);
  } catch (e) {
    return Response.json(
      { error: "Couldn't understand the AI's response. Try rephrasing or a clearer photo.", raw: rawText.slice(0, 300) },
      { status: 502 }
    );
  }

  return Response.json({ extracted });
}
