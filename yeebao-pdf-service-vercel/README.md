# Yeebao PDF Service — Vercel

這是 Yeebao 0.3.67 Chromium PDF Service 的 Vercel Serverless 版本。

## Vercel Environment Variables

至少設定：

- `YEEBAO_SITE_URL=https://你的易報網域.com`
- `YEEBAO_ALLOWED_ORIGIN=https://你的易報網域.com`

選用：

- `YEEBAO_QUOTATION_DETAIL_PATH=/quotation-detail/`
- `YEEBAO_PDF_TIMEOUT_MS=45000`
- `CHROMIUM_PACK_URL=...`

若沒有設定 `CHROMIUM_PACK_URL`，程式預設使用 Sparticuz Chromium 149 的 x64 release pack。

## Endpoint

- `GET /health`
- `POST /v1/quotation-pdf`

路徑與 Yeebao Core 0.3.67 原本預期完全相同，所以 WordPress 外掛不用再修改。

## WordPress wp-config.php

```php
define('YEEBAO_PDF_SERVICE_URL', 'https://你的專案.vercel.app');
```

最後不要加 `/`。
