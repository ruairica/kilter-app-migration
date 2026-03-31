export default async function handler(req, res) {
  // Strip /api/kilter prefix to get the Kilter API path + query string
  const kilterPath = req.url.replace(/^\/api\/kilter/, '');
  const url = `https://portal.kiltergrips.com/api${kilterPath}`;

  const headers = { Accept: 'application/json' };
  if (req.headers.authorization) headers['Authorization'] = req.headers.authorization;
  if (req.method === 'POST') headers['Content-Type'] = 'application/json';

  const options = { method: req.method, headers };
  if (req.method === 'POST') options.body = JSON.stringify(req.body);

  try {
    const r = await fetch(url, options);
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    res.status(r.status).json(data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
}
