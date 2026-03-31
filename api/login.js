export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  try {
    const { username, password } = req.body;
    const r = await fetch('https://idp.kiltergrips.com/realms/kilter/protocol/openid-connect/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: 'kilter',
        scope: 'openid offline_access',
        username,
        password,
      }).toString(),
    });
    if (!r.ok) {
      const text = await r.text();
      return res.status(401).json({ error: `Auth failed: ${r.status} ${text}` });
    }
    const { access_token } = await r.json();
    const b64 = access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(Buffer.from(b64, 'base64').toString());
    res.json({ token: access_token, userUuid: payload.sub });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
