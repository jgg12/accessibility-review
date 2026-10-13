
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { XMLParser } from 'fast-xml-parser';
import fs from 'node:fs/promises';
import path from 'node:path';
import dns from 'node:dns/promises';
import net from 'node:net';

const siteInput = process.env.SITE_URL || process.argv[2];
const requestedMax = Number(process.env.MAX_PAGES || 25);
const maxPages = Number.isFinite(requestedMax)
  ? Math.min(Math.max(Math.floor(requestedMax), 1), 100)
  : 25;
const outputDir = path.resolve('docs');

if (!siteInput) {
  throw new Error('Set SITE_URL or pass a website URL.');
}

const site = new URL(siteInput);

if (site.protocol !== 'https:') {
  throw new Error('Only HTTPS websites are supported.');
}

if (site.username || site.password || site.port) {
  throw new Error('Credentials and custom ports are not supported.');
}

const allowed = (process.env.ALLOWED_HOSTS || '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

if (!allowed.length) {
  throw new Error(
    'Set ALLOWED_HOSTS to a comma-separated list of authorized exact hostnames.'
  );
}

const hostname = site.hostname.toLowerCase();

if (
  !allowed.includes(hostname) &&
  !(
    process.env.ALLOW_SITES_SUBDOMAINS === 'true' &&
    (
      hostname === 'sites.psu.edu' ||
      hostname.endsWith('.sites.psu.edu')
    )
  )
) {
  throw new Error(`Host ${hostname} is not authorized.`);
}

// --------------------------------------------------
// Network security
// --------------------------------------------------

function isPrivate(ip) {
  if (net.isIP(ip) === 4) {
    const p = ip.split('.').map(Number);

    return (
      p[0] === 0 ||
      p[0] === 10 ||
      p[0] === 127 ||
      p[0] >= 224 ||
      (p[0] === 169 && p[1] === 254) ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168) ||
      (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||
      (p[0] === 192 && p[1] === 0 && p[2] === 0) ||
      (p[0] === 192 && p[1] === 0 && p[2] === 2) ||
      (p[0] === 192 && p[1] === 88 && p[2] === 99) ||
      (p[0] === 198 && (p[1] === 18 || p[1] === 19)) ||
      (p[0] === 198 && p[1] === 51 && p[2] === 100) ||
      (p[0] === 203 && p[1] === 0 && p[2] === 113)
    );
  }

  if (net.isIP(ip) === 6) {
    const s = ip.toLowerCase();

    if (s.includes('.')) return true;

    return (
      s === '::1' ||
      s === '::' ||
      s.startsWith('fc') ||
      s.startsWith('fd') ||
      /^fe[89ab]/.test(s) ||
      s.startsWith('::ffff:') ||
      s.startsWith('2001:db8:')
    );
  }

  return true;
}

async function validateHost() {
  const addresses = await dns.lookup(hostname, { all: true });

  if (
    !addresses.length ||
    addresses.some(a => isPrivate(a.address))
  ) {
    throw new Error(
      'Target hostname resolves to a non-public address.'
    );
  }
}

await validateHost();

// --------------------------------------------------
// Site boundary
// --------------------------------------------------

const origin = site.origin;

// Example:
// https://sites.psu.edu/teachingonlineprogram/
// Only this path and its descendants are allowed.

const siteRoot = site.pathname.replace(/\/+$/, '');
const sitePath = siteRoot + '/';

function sameOriginUrl(raw, base = site.toString()) {
  try {
    const u = new URL(raw, base);

    if (
      u.origin !== origin ||
      u.protocol !== 'https:' ||
      u.username ||
      u.password ||
      u.port
    ) {
      return null;
    }

    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}

function sameSiteUrl(raw, base = site.toString()) {
  const normalized = sameOriginUrl(raw, base);
  if (!normalized) return null;

  const u = new URL(normalized);

  if (
    siteRoot &&
    u.pathname !== siteRoot &&
    !u.pathname.startsWith(sitePath)
  ) {
    return null;
  }

  // Avoid scanning administrative, login, and API pages.
  if (
    /\/(?:wp-admin|wp-json)(?:\/|$)/i.test(u.pathname) ||
    /\/wp-login\.php$/i.test(u.pathname)
  ) {
    return null;
  }

  // Avoid non-HTML documents.
  if (
    /\.(?:pdf|jpg|jpeg|png|gif|webp|svg|zip|xml|json|css|js|mp4|mp3|docx?|xlsx?|pptx?)(?:$)/i.test(
      u.pathname
    )
  ) {
    return null;
  }

  return normalized;
}

const normalizedSite = sameSiteUrl(site.toString());

if (!normalizedSite) {
  throw new Error('The requested site URL is not permitted.');
}

console.log(`Requested site: ${normalizedSite}`);
console.log(`Site boundary: ${origin}${sitePath}`);
console.log(`Maximum pages: ${maxPages}`);

// --------------------------------------------------
// Sitemap discovery
// --------------------------------------------------

async function safeFetch(url) {
  const u = sameOriginUrl(url);

  if (!u) {
    throw new Error('Cross-origin sitemap URL rejected.');
  }

  await validateHost();

  const response = await fetch(u, {
    signal: AbortSignal.timeout(15000),
    redirect: 'manual',
    headers: {
      'User-Agent': 'CEI-Accessibility-Scanner/0.2'
    }
  });

  if (response.status >= 300 && response.status < 400) {
    throw new Error(
      `Sitemap redirect rejected: HTTP ${response.status}`
    );
  }

  if (!response.ok) {
    throw new Error(`Sitemap HTTP ${response.status}`);
  }

  const contentType = response.headers.get('content-type') || '';

  if (
    !contentType.includes('xml') &&
    !contentType.includes('text/plain')
  ) {
    throw new Error('Sitemap response is not XML.');
  }

  const maxBytes = 5 * 1024 * 1024;
  const reader = response.body?.getReader();

  if (!reader) {
    throw new Error('Sitemap response has no body.');
  }

  const chunks = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      total += value.byteLength;

      if (total > maxBytes) {
        await reader.cancel();
        throw new Error('Sitemap exceeds 5 MB limit.');
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks).toString('utf8');
}

const parser = new XMLParser({
  ignoreAttributes: false
});

const asArray = v =>
  v === undefined ? [] : Array.isArray(v) ? v : [v];

function sitemapCandidates() {
  const candidates = [
    new URL('wp-sitemap.xml', origin + sitePath).toString(),
    new URL('sitemap_index.xml', origin + sitePath).toString(),
    new URL('sitemap.xml', origin + sitePath).toString()
  ];

  // Domain-level sitemaps may contain many unrelated
  // WordPress sites. We do not crawl them.

  return [...new Set(candidates)];
}

async function discoverFromSitemaps() {
  const urls = new Set();
  const pending = sitemapCandidates();
  const seen = new Set();

  while (
    pending.length &&
    seen.size < 30 &&
    urls.size < maxPages
  ) {
    const sitemap = pending.shift();

    if (!sameOriginUrl(sitemap) || seen.has(sitemap)) {
      continue;
    }

    seen.add(sitemap);

    try {
      const xml = parser.parse(await safeFetch(sitemap));

      for (const item of asArray(xml.sitemapindex?.sitemap)) {
        const link = sameOriginUrl(item.loc);

        // Only follow sitemap files located inside
        // the requested WordPress site's directory.
        if (
          link &&
          new URL(link).pathname.startsWith(sitePath) &&
          !seen.has(link)
        ) {
          pending.push(link);
        }
      }

      for (const item of asArray(xml.urlset?.url)) {
        const link = sameSiteUrl(item.loc);

        if (link) {
          urls.add(link);
        }

        if (urls.size >= maxPages) break;
      }
    } catch (error) {
      console.log(
        `Skipping sitemap ${sitemap}: ${error.message}`
      );
    }
  }

  return [...urls];
}

// --------------------------------------------------
// Browser and page discovery
// --------------------------------------------------

const browser = await chromium.launch({
  headless: true
});

const pages = [];
const queue = [normalizedSite];
const queued = new Set(queue);
const visited = new Set();

try {
  const sitemapUrls = await discoverFromSitemaps();

  for (const url of sitemapUrls) {
    if (queue.length >= maxPages) break;

    if (!queued.has(url)) {
      queue.push(url);
      queued.add(url);
    }
  }

  console.log(
    `Discovered ${queue.length} initial page(s).`
  );

  while (queue.length && visited.size < maxPages) {
    const url = queue.shift();

    if (visited.has(url)) continue;
    visited.add(url);

    console.log(`Scanning: ${url}`);

    const context = await browser.newContext({
      ignoreHTTPSErrors: false,
      serviceWorkers: 'block'
    });

    const page = await context.newPage();

    let blockedNavigation = null;

    // Prevent main-frame navigation outside the
    // requested WordPress site. Assets may load
    // from external domains as normal.
    await page.route('**/*', async route => {
      const request = route.request();

      if (
        request.isNavigationRequest() &&
        request.frame() === page.mainFrame() &&
        !sameSiteUrl(request.url())
      ) {
        blockedNavigation = request.url();
        return route.abort();
      }

      return route.continue();
    });

    try {
      const response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      });

      if (!response) {
        throw new Error(
          blockedNavigation
            ? `Navigation redirected outside the requested site: ${blockedNavigation}`
            : 'Navigation returned no HTTP response.'
        );
      }

      const finalUrl = page.url();

      if (!sameSiteUrl(finalUrl)) {
        throw new Error(
          `Page redirected outside the requested site: ${finalUrl}`
        );
      }

      if (!response.ok()) {
        throw new Error(
          `HTTP ${response.status()} at ${finalUrl}`
        );
      }

      const contentType =
        response.headers()['content-type'] || '';

      if (
        contentType &&
        !contentType.includes('text/html')
      ) {
        throw new Error(
          `Expected HTML but received ${contentType}`
        );
      }

      await page.waitForTimeout(700);

      // Discover links from this page before scanning.
      // Only links inside the requested site are queued.
      const links = await page.locator('a[href]').evaluateAll(
        elements => elements.map(a => a.href)
      );

      for (const raw of links) {
        if (queued.size >= maxPages) break;

        const link = sameSiteUrl(raw, finalUrl);

        if (
          link &&
          !queued.has(link) &&
          !visited.has(link)
        ) {
          queue.push(link);
          queued.add(link);
        }
      }

      const result = await new AxeBuilder({ page })
        .withTags([
          'wcag2a',
          'wcag2aa',
          'wcag21a',
          'wcag21aa',
          'wcag22aa'
        ])
        .analyze();

      const violations = result.violations.map(v => ({
        id: v.id,
        impact: v.impact,
        description: v.description,
        help: v.help,
        helpUrl: v.helpUrl,
        nodes: v.nodes.map(n => ({
          target: n.target,
          html: n.html,
          failureSummary: n.failureSummary
        }))
      }));

      pages.push({
        url,
        title: await page.title(),
        status: 'scanned',
        violations,
        incompleteCount: result.incomplete.length
      });

      console.log(
        `✓ ${url}: ${violations.length} rule violations`
      );
    } catch (error) {
      let message = error.message;

      if (blockedNavigation) {
        message =
          `Navigation blocked outside requested site: ${blockedNavigation}. ` +
          message;
      } else if (
        message.includes('Timeout') ||
        message.includes('timeout')
      ) {
        message =
          `Page navigation or scan timed out: ${message}`;
      }

      pages.push({
        url,
        title: '',
        status: 'error',
        error: message,
        violations: [],
        incompleteCount: 0
      });

      console.log(`✗ ${url}: ${message}`);
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
}

// --------------------------------------------------
// Generate JSON report
// --------------------------------------------------

const report = {
  site: normalizedSite,
  scannedAt: new Date().toISOString(),
  scannedPages: pages.filter(
    p => p.status === 'scanned'
  ).length,
  failedPages: pages.filter(
    p => p.status === 'error'
  ).length,
  ruleViolations: pages.reduce(
    (n, p) => n + p.violations.length,
    0
  ),
  affectedPages: pages.filter(
    p => p.violations.length > 0
  ).length,
  pages
};

await fs.mkdir(outputDir, {
  recursive: true
});

await fs.writeFile(
  path.join(outputDir, 'report.json'),
  JSON.stringify(report, null, 2)
);

// --------------------------------------------------
// Generate CSV report
// --------------------------------------------------

const csvEscape = value =>
  `"${String(value ?? '').replaceAll('"', '""')}"`;

const rows = [[
  'page',
  'status',
  'rule_id',
  'impact',
  'description',
  'affected_elements',
  'help_url',
  'error'
]];

for (const p of pages) {
  if (!p.violations.length) {
    rows.push([
      p.url,
      p.status,
      '',
      '',
      '',
      '',
      '',
      p.error || ''
    ]);
  }

  for (const v of p.violations) {
    rows.push([
      p.url,
      p.status,
      v.id,
      v.impact,
      v.help,
      v.nodes.length,
      v.helpUrl,
      ''
    ]);
  }
}

await fs.writeFile(
  path.join(outputDir, 'report.csv'),
  rows
    .map(row => row.map(csvEscape).join(','))
    .join('\n')
);

console.log('-----------------------------------');
console.log('Accessibility review complete');
console.log(`Site: ${report.site}`);
console.log(`Pages scanned: ${report.scannedPages}`);
console.log(`Pages failed: ${report.failedPages}`);
console.log(`Rule violations: ${report.ruleViolations}`);
console.log(`Affected pages: ${report.affectedPages}`);
console.log(`Report written to ${outputDir}`);
console.log('-----------------------------------');
