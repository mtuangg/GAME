// ============================================================
// POST /api/food-estimate
// Body: { text?: string, image?: { mediaType: string, data: string (base64) } }
// Proxies a nutrition-estimate request to Anthropic using a server-held
// API key, so the key never ships to the browser. Returns
// { calories, proteinG, carbsG, fatG } or a clean 4xx/5xx error.
// ============================================================
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY || '';
  if (!apiKey) return res.status(501).json({ error: 'AI estimate not configured — set ANTHROPIC_API_KEY in Vercel env vars' });

  const body = req.body || {};
  const text = typeof body.text === 'string' ? body.text.slice(0, 2000) : '';
  const image = body.image && typeof body.image === 'object' ? body.image : null;
  const imageData = image && typeof image.data === 'string' ? image.data : null;
  const imageMediaType = image && typeof image.mediaType === 'string' ? image.mediaType : null;

  if (!text && !imageData) return res.status(400).json({ error: 'text or image required' });

  const content = [{
    type: 'text',
    text: 'Estimate the nutrition for this meal. Return ONLY a JSON object like ' +
      '{"calories":number,"proteinG":number,"carbsG":number,"fatG":number} — no preamble, no code fences.' +
      (text ? ('\n\nDescription: ' + text) : '')
  }];
  if (imageData && imageMediaType) {
    content.push({ type: 'image', source: { type: 'base64', media_type: imageMediaType, data: imageData } });
  }

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 300, messages: [{ role: 'user', content }] }),
    });
    if (!r.ok) {
      const errText = await r.text().catch(() => '');
      return res.status(502).json({ error: 'Anthropic request failed: ' + r.status + ' ' + errText.slice(0, 300) });
    }
    const data = await r.json();
    const raw = (data && data.content && data.content[0] && data.content[0].text) || '';
    let parsed;
    try { parsed = JSON.parse(raw); } catch (e) { return res.status(502).json({ error: 'model did not return valid JSON' }); }

    // Bounds-check before handing numbers back to the client — reject
    // negative/absurd values instead of passing a hallucinated or
    // malformed number straight into the day's calorie total.
    const clean = {};
    const fields = { calories: [0, 5000], proteinG: [0, 500], carbsG: [0, 1000], fatG: [0, 500] };
    for (const [key, [min, max]] of Object.entries(fields)) {
      const v = parsed[key];
      if (typeof v === 'number' && isFinite(v) && v >= min && v <= max) clean[key] = Math.round(v);
    }
    if (Object.keys(clean).length === 0) return res.status(502).json({ error: 'model returned no usable values' });
    return res.status(200).json(clean);
  } catch (e) {
    return res.status(500).json({ error: 'proxy fetch failed: ' + (e && e.message ? e.message : String(e)) });
  }
}
