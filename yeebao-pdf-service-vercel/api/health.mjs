function normalizeSiteUrl(value) {
  try {
    const u = new URL(String(value || '').trim());
    if (!/^https?:$/.test(u.protocol)) return '';
    return u.origin;
  } catch {
    return '';
  }
}

export default function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ ok: false, message: 'Method not allowed.' });
    return;
  }
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    ok: true,
    service: 'yeebao-pdf-service-vercel',
    site: normalizeSiteUrl(process.env.YEEBAO_SITE_URL || '')
  });
}
