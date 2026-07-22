// Cloudflare Pages Function
// Deploys automatically at:  https://<your-site>.pages.dev/ai-fill
// Requires an environment variable set in the Cloudflare dashboard:
//   Pages project → Settings → Environment Variables → ANTHROPIC_API_KEY (Encrypted)

const SYSTEM_PROMPT = `You extract group-buy event details from a host's pasted text and/or an uploaded photo (poster, menu, price list, chat message screenshot, etc.).

Return ONLY valid JSON — no markdown fences, no commentary, no leading/trailing text. Match this exact shape:

{
  "title": string | null,
  "description": string | null,
  "address": string | null,
  "closingDate": "YYYY-MM-DD" | null,
  "collectionDate": "YYYY-MM-DD" | null,
  "timeFrom": "HH:MM" | null,
  "timeTo": "HH:MM" | null,
  "bannerBox": { "x": number, "y": number, "w": number, "h": number } | null,
  "items": [
    {
      "name": string,
      "description": string | null,
      "price": number | null,
      "imageBox": { "x": number, "y": number, "w": number, "h": number } | null
    }
  ]
}

Rules:
- Use null for any field not clearly present in the source material. Never invent a date, price, or address that isn't stated.
- "items" should be an empty array if no distinct products/items are mentioned.
- Dates: if a relative date is mentioned (e.g. "this Friday") and no absolute date is given, return null for that field rather than guessing a calendar date.
- Prices: strip currency symbols, return as a plain number (e.g. 18.90, not "$18.90").
- If the source is a screenshot of a chat conversation, focus on the message that actually describes the group buy, not surrounding chatter.

Image cropping boxes (only if an image was provided):
- All box coordinates are FRACTIONS of the source image's width/height, from 0 to 1, with (0,0) at the top-left corner. Example: a region starting a quarter of the way down, spanning the full width, for the top 20% of the image: {"x":0,"y":0.25,"w":1,"h":0.2}.
- "bannerBox": a region suitable as a wide event banner (e.g. a hero photo/collage area, title graphic, or a representative food shot). Null if the image has no suitable banner-like region (e.g. it's just a text price list).
- Each item's "imageBox": the region showing that specific product's own photo, if the image contains individual product photos. Null if that item has no distinguishable photo of its own (e.g. it's plain text on a price list, or shares an image with other items you can't separate cleanly).
- These are approximate regions for a client-side crop, not pixel-perfect — favor a slightly generous box over cutting off part of the subject.
- If no image was provided at all, set "bannerBox" to null and every item's "imageBox" to null.`;

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
        system: SYSTEM_PROMPT,
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
