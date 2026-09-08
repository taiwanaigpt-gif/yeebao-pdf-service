import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';

const SITE_URL = normalizeSiteUrl(process.env.YEEBAO_SITE_URL || '');
const ALLOWED_ORIGIN = normalizeOrigin(process.env.YEEBAO_ALLOWED_ORIGIN || SITE_URL);
const TIMEOUT_MS = positiveInt(process.env.YEEBAO_PDF_TIMEOUT_MS, 30000);
const MAX_HTML_BYTES = positiveInt(process.env.YEEBAO_PDF_MAX_HTML_BYTES, 2500000);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    if (size > MAX_HTML_BYTES + 262144) throw new Error('Request body is too large.');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
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

function validateSourceUrl(value) {
  if (!value) return true;
  try {
    const u = new URL(String(value));
    return !SITE_URL || u.origin === SITE_URL;
  } catch {
    return false;
  }
}

async function launchBrowser() {
  chromium.setGraphicsMode = false;
  const executablePath = await chromium.executablePath();
  return puppeteer.launch({
    args: chromium.args,
    executablePath,
    headless: 'shell',
    defaultViewport: { width: 1440, height: 1200, deviceScaleFactor: 1 }
  });
}

async function renderHtmlPdf(html) {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(TIMEOUT_MS);
    page.setDefaultNavigationTimeout(TIMEOUT_MS);

    // 1.0.2：直接轉換使用者瀏覽器已渲染完成的列印 HTML。
    // 不再重新登入 WordPress，也不再等待 quotation-detail 的 REST API。
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: Math.min(TIMEOUT_MS, 15000) });

    const state = await page.evaluate(async () => {
      const root = document.getElementById('yb-quote-print-root');
      const paper = root?.querySelector('.yb-quote-paper');
      if (!root || !paper) {
        return { ok: false, message: 'Rendered HTML does not contain the quotation print root.' };
      }

      document.body.classList.add('yb-quote-printing');
      root.setAttribute('aria-hidden', 'false');

      if (document.fonts?.ready) {
        try {
          await Promise.race([
            document.fonts.ready,
            new Promise((resolve) => setTimeout(resolve, 5000))
          ]);
        } catch {}
      }

      const images = Array.from(root.querySelectorAll('img'));
      await Promise.all(images.map((img) => new Promise((resolve) => {
        if (img.complete) {
          if (typeof img.decode === 'function' && img.naturalWidth > 0) {
            Promise.race([
              img.decode().catch(() => {}),
              new Promise((r) => setTimeout(r, 4000))
            ]).finally(resolve);
            return;
          }
          resolve();
          return;
        }
        const done = () => resolve();
        img.addEventListener('load', done, { once: true });
        img.addEventListener('error', done, { once: true });
        setTimeout(done, 5000);
      })));

      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return { ok: true };
    });

    if (!state?.ok) {
      const error = new Error(state?.message || 'Quotation print root is missing.');
      error.status = 400;
      throw error;
    }

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
  if (!originAllowed(req)) return res.status(403).json({ ok: false, message: 'Origin is not allowed.' });

  // 仍要求易報登入 Token，避免瀏覽器匿名直接濫用 PDF endpoint。
  // 1.0.2 不再用此 Token 重新呼叫 Bluehost / WordPress REST API。
  const accessToken = getBearer(req);
  if (!accessToken) return res.status(401).json({ ok: false, message: 'Missing Authorization: Bearer token.' });

  let body;
  try { body = await getJsonBody(req); }
  catch (error) { return res.status(400).json({ ok: false, message: error?.message || 'Invalid JSON body.' }); }

  const quotationId = String(body.quotationId || '').trim();
  const html = typeof body.html === 'string' ? body.html : '';
  const sourceUrl = String(body.sourceUrl || '').trim();

  if (!UUID_RE.test(quotationId)) return res.status(400).json({ ok: false, message: 'Valid quotationId is required.' });
  if (!validateSourceUrl(sourceUrl)) return res.status(403).json({ ok: false, message: 'Invalid sourceUrl origin.' });
  if (!html || !html.includes('id="yb-quote-print-root"') || !html.includes('yb-quote-paper')) {
    return res.status(400).json({ ok: false, message: 'Rendered quotation HTML is required.' });
  }
  if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) {
    return res.status(413).json({ ok: false, message: 'Rendered quotation HTML is too large.' });
  }

  const filename = sanitizeFilename(body.filename);

  try {
    const pdf = await renderHtmlPdf(html);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', contentDisposition(filename));
    res.setHeader('Content-Length', String(pdf.length));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.status(200).send(Buffer.from(pdf));
  } catch (error) {
    console.error('[Yeebao PDF 1.0.2]', quotationId, error);
    const status = Number(error?.status) || 500;
    return res.status(status).json({
      ok: false,
      message: status >= 500
        ? ('PDF 產生失敗：' + (error?.message || 'Chromium error'))
        : (error?.message || 'PDF request failed.')
    });
  }
}
