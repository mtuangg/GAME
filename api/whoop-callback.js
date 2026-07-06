// ============================================================
// GET /api/whoop-callback?code=...&state=...
// Receives the OAuth code from WHOOP, exchanges it for tokens,
// and bounces back to /health.html with the tokens in the URL
// hash. The hash never reaches the server — only the browser
// reads it, then stores the tokens in localStorage.
// Env vars required on Vercel:
//   WHOOP_CLIENT_ID
//   WHOOP_CLIENT_SECRET
//   WHOOP_REDIRECT_URI  (full https URL — same one configured in
//                       the WHOOP developer dashboard)
// ============================================================
export default async function handler(req, res) {
  const code = req.query && req.query.code;
  const errorParam = req.query && req.query.error;
  // Echoed back to the client unchanged — this server is stateless (no
  // session store), so it can't verify the state itself. health.html
  // compares this against the value it stashed in sessionStorage before
  // redirecting here, and refuses to save tokens on a mismatch.
  const state = (req.query && req.query.state) || '';
  if (errorParam) return res.status(400).send('WHOOP auth error: ' + errorParam);
  if (!code) return res.status(400).send('Missing code parameter.');

  const clientId     = process.env.WHOOP_CLIENT_ID;
  const clientSecret = process.env.WHOOP_CLIENT_SECRET;
  // ALWAYS derive the redirect from the live host. WHOOP sends the browser
  // back to whatever redirect_uri was used at login (i.e. this exact origin),
  // so deriving it here guarantees the token-exchange redirect_uri matches
  // the authorize redirect_uri — regardless of any env var.
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
  const host  = req.headers['x-forwarded-host'] || req.headers.host;
  const redirectUri = proto + '://' + host + '/api/whoop-callback';
  if (!clientId || !clientSecret) {
    return res.status(500).send('Server not configured (missing WHOOP_CLIENT_ID / WHOOP_CLIENT_SECRET).');
  }

  try {
    const body = new URLSearchParams({
      grant_type:    'authorization_code',
      code,
      redirect_uri:  redirectUri,
      client_id:     clientId,
      client_secret: clientSecret,
    });
    const tokenRes = await fetch('https://api.prod.whoop.com/oauth/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const text = await tokenRes.text();
    if (!tokenRes.ok) {
      return res.status(500).send('WHOOP token exchange failed: ' + text);
    }
    let json;
    try { json = JSON.parse(text); } catch (e) {
      return res.status(500).send('WHOOP returned non-JSON: ' + text);
    }
    const access = json.access_token || '';
    const refresh = json.refresh_token || '';
    const expiresIn = json.expires_in || 3600;
    const hash = new URLSearchParams({
      whoop_access:  access,
      whoop_refresh: refresh,
      whoop_expires: String(Date.now() + expiresIn * 1000),
      whoop_state:   state,
    }).toString();
    res.writeHead(302, { Location: '/health.html#' + hash });
    res.end();
  } catch (e) {
    res.status(500).send('Unexpected error: ' + (e && e.message ? e.message : String(e)));
  }
}
