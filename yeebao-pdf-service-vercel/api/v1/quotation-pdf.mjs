import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium-min';

const SITE_URL = normalizeSiteUrl(process.env.YEEBAO_SITE_URL || '');
const ALLOWED_ORIGIN = normalizeOrigin(process.env.YEEBAO_ALLOWED_ORIGIN || SITE_URL);
const DETAIL_PATH = normalizePath(process.env.YEEBAO_QUOTATION_DETAIL_PATH || '/quotation-detail/');
const TIMEOUT_MS = positiveInt(process.env.YEEBAO_PDF_TIMEOUT_MS, 45000);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_CHROMIUM_PACK_URL = 'https://github.com/Sparticuz/chromium/releases/download/v149.0.0/chromium-v149.0.0-pack.x64.tar';

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeSiteUrl(value) {
  try {
    const u = new URL(String(value || '').trim());
    if (!/^https?:$/.test(u.protocol)) return '';
    return u.origin;
  } catch {
    return '';
  }
}

function normalizeOrigin(value) {
  try { return new URL(String(value || '').trim()).origin; }
  catch { return ''; }
}

function normalizePath(value) {
  let p = String(value || '/quotation-detail/').trim();
  if (!p.startsWith('/')) p = '/' + p;
  if (!p.endsWith('/')) p += '/';
  return p;
}

function applyCors(req, res) {
  const origin = String(req.headers.origin || '');
  if (origin && ALLOWED_ORIGIN && origin === ALLOWED_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Max-Age', '600');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Cache-Control', 'no-store');
}

function originAllowed(req) {
  const origin = String(req.headers.origin || '');
  return !origin || !ALLOWED_ORIGIN || origin === ALLOWED_ORIGIN;
}

function getBearer(req) {
  const value = String(req.headers.authorization || '');
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

async function getJsonBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') return req.body ? JSON.parse(req.body) : {};

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16384) throw new Error('Request body is too large.');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

async function validateQuotationAccess(accessToken, quotationId, versionNo) {
  let apiUrl = SITE_URL + '/wp-json/yeebao/v1/quotations/' + encodeURIComponent(quotationId);
  if (versionNo !== null) apiUrl += '/versions/' + encodeURIComponent(String(versionNo));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(TIMEOUT_MS, 15000));
  try {
    const response = await fetch(apiUrl, {
      method: 'GET',
      headers: {
        authorization: 'Bearer ' + accessToken,
        accept: 'application/json'
      },
      signal: controller.signal
    });
    if (!response.ok) {
      let message = '';
      try {
        const data = await response.json();
        message = data?.message || data?.code || '';
      } catch {}
      const error = new Error(message || 'Quotation access validation failed.');
      error.status = [401, 403, 404].includes(response.status) ? response.status : 502;
      throw error;
    }
  } finally {
    clearTimeout(timer);
  }
}

function sanitizeFilename(value) {
  let name = String(value || '易報_報價單.pdf').trim();
  name = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim();
  name = name.replace(/[. ]+$/g, '');
  if (!name.toLowerCase().endsWith('.pdf')) name += '.pdf';
  return (name || '易報_報價單.pdf').slice(0, 180);
}

function contentDisposition(filename) {
  return `attachment; filename="yeebao-quotation.pdf"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

async function launchBrowser() {
  chromium.setGraphicsMode = false;
  const packUrl = process.env.CHROMIUM_PACK_URL || DEFAULT_CHROMIUM_PACK_URL;
  const executablePath = await chromium.executablePath(packUrl);
  const args = await puppeteer.defaultArgs({ args: chromium.args, headless: 'shell' });
  return puppeteer.launch({
    args,
    executablePath,
    headless: 'shell',
    defaultViewport: { width: 1440, height: 1200, deviceScaleFactor: 1 }
  });
}

async function renderQuotationPdf({ accessToken, quotationId, versionNo }) {
  await validateQuotationAccess(accessToken, quotationId, versionNo);

  const detailUrl = new URL(DETAIL_PATH, SITE_URL + '/');
  detailUrl.searchParams.set('quotation_id', quotationId);
  if (versionNo !== null) detailUrl.searchParams.set('version_no', String(versionNo));

  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(TIMEOUT_MS);
    page.setDefaultNavigationTimeout(TIMEOUT_MS);

    await page.evaluateOnNewDocument((token) => {
      try { localStorage.setItem('yeebao_access_token', token); } catch {}
    }, accessToken);

    await page.goto(detailUrl.toString(), { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
    await page.waitForSelector('#yb-quote-print-root .yb-quote-paper', { timeout: TIMEOUT_MS });

    await page.evaluate(async () => {
      const root = document.getElementById('yb-quote-print-root');
      const paper = root?.querySelector('.yb-quote-paper');
      if (!root || !paper) throw new Error('Quotation print root was not created.');

      document.body.classList.add('yb-quote-printing');
      root.setAttribute('aria-hidden', 'false');

      if (document.fonts?.ready) {
        try { await document.fonts.ready; } catch {}
      }

      const images = Array.from(root.querySelectorAll('img'));
      await Promise.all(images.map((img) => {
        if (img.complete) {
          if (typeof img.decode === 'function' && img.naturalWidth > 0) return img.decode().catch(() => {});
          return Promise.resolve();
        }
        return new Promise((resolve) => {
          const done = () => resolve();
          img.addEventListener('load', done, { once: true });
          img.addEventListener('error', done, { once: true });
        });
      }));

      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });

    await page.emulateMediaType('print');
    return await page.pdf({
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: false,
      scale: 1,
      timeout: TIMEOUT_MS
    });
  } finally {
    await browser.close().catch(() => {});
  }
}

export default async function handler(req, res) {
  applyCors(req, res);

  if (req.method === 'OPTIONS') {
    if (!originAllowed(req)) return res.status(403).json({ ok: false, message: 'Origin is not allowed.' });
    return res.status(204).end();
  }

  if (req.method !== 'POST') return res.status(405).json({ ok: false, message: 'Method not allowed.' });
  if (!SITE_URL) return res.status(500).json({ ok: false, message: 'Missing YEEBAO_SITE_URL.' });
  if (!originAllowed(req)) return res.status(403).json({ ok: false, message: 'Origin is not allowed.' });

  const accessToken = getBearer(req);
  if (!accessToken) return res.status(401).json({ ok: false, message: 'Missing Authorization: Bearer token.' });

  let body;
  try { body = await getJsonBody(req); }
  catch (error) { return res.status(400).json({ ok: false, message: error?.message || 'Invalid JSON body.' }); }

  const quotationId = String(body.quotationId || '').trim();
  const rawVersion = body.versionNo;
  const versionNo = rawVersion === undefined || rawVersion === null || rawVersion === ''
    ? null
    : Number.parseInt(String(rawVersion), 10);

  if (!UUID_RE.test(quotationId)) return res.status(400).json({ ok: false, message: 'Valid quotationId is required.' });
  if (versionNo !== null && (!Number.isInteger(versionNo) || versionNo < 0 || versionNo > 1000000)) {
    return res.status(400).json({ ok: false, message: 'Invalid versionNo.' });
  }

  const filename = sanitizeFilename(body.filename);

  try {
    const pdf = await renderQuotationPdf({ accessToken, quotationId, versionNo });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', contentDisposition(filename));
    res.setHeader('Content-Length', String(pdf.length));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.status(200).send(Buffer.from(pdf));
  } catch (error) {
    console.error('[Yeebao PDF]', quotationId, error);
    const status = Number(error?.status) || 500;
    return res.status(status).json({
      ok: false,
      message: status >= 500
        ? 'PDF 產生失敗，請查看 Vercel Function Logs。'
        : (error?.message || 'PDF request failed.')
    });
  }
}
