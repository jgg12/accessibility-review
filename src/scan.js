
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { XMLParser } from 'fast-xml-parser';
import fs from 'node:fs/promises';
import path from 'node:path';
import dns from 'node:dns/promises';
import net from 'node:net';

const siteInput = process.env.SITE_URL || process.argv[2];
const maxPages = Math.min(
  Math.max(Number(process.env.MAX_PAGES || 25) || 25, 1),
  100
);
const outputDir = path.resolve('docs');

if (!siteInput) {
  throw new Error('Set SITE_URL or pass a website URL.');
}

function approvedHost(hostname) {
  const host = hostname.toLowerCase();
  return host === 'psu.edu' || host.endsWith('.psu.edu');
}

function checkedUrl(raw, base) {
  const url = new URL(raw, base);

  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    !approvedHost(url.hostname)
  ) {
    throw new Error(`Unapproved URL: ${url}`);
  }

  url.hash = '';
  return url;
}

const requestedSite = checkedUrl(siteInput);

if (requestedSite.hostname !== 'sites.psu.edu') {
  throw new Error('Starting URL must be on sites.psu.edu.');
}

function privateIP(ip) {
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
      (p[0] === 198 && [18, 19].includes(p[1]))
    );
  }

  if (net.isIP(ip) === 6) {
    const s = ip.toLowerCase();

    return (
      s === '::' ||
      s === '::1' ||
      s.startsWith('fc') ||
      s.startsWith('fd') ||
      s.startsWith('fe8') ||
      s.startsWith('fe9') ||
      s.startsWith('fea') ||
      s.startsWith('feb') ||
      s.startsWith('::ffff:')
    );
  }

  return true;
}

async function validateHost(hostname) {
  if (!approvedHost(hostname)) {
    throw new Error(`Unapproved hostname: ${hostname}`);
  }

  const addresses = await dns.lookup(hostname, { all: true });

  if (!addresses.length || addresses.some(a => privateIP(a.address))) {
    throw new Error(`Non-public address: ${hostname}`);
  }
}

async function resolveRedirects(input) {
  let current = checkedUrl(input);

  for (let i = 0; i < 8; i++) {
    await validateHost(current.hostname);

    const response = await fetch(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(15000)
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');

      if (!location) {
        throw new Error('Redirect missing Location header.');
      }

      const next = checkedUrl(location, current);

      console.log(`Redirect: ${current} -> ${next}`);
      current = next;
      continue;
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${current}`);
    }

    return current;
  }

  throw new Error('Too many redirects.');
}

const resolvedSite = await resolveRedirects(requestedSite);
const origin = resolvedSite.origin;

console.log(`Requested site: ${requestedSite}`);
console.log(`Resolved destination: ${resolvedSite}`);

const sitePath = resolvedSite.hostname === 'sites.psu.edu'
  ? resolvedSite.pathname.replace(/\/?$/, '/')
  : '/';

function withinSite(raw, base = origin) {
  try {
    const url = checkedUrl(raw, base);

    if (url.origin !== origin) return null;

    if (sitePath !== '/') {
      const root = sitePath.slice(0, -1);

      if (
        url.pathname !== root &&
        !url.pathname.startsWith(sitePath)
      ) {
        return null;
      }
    }

    return url.toString();
  } catch {
    return null;
  }
}

const parser = new XMLParser({ ignoreAttributes: false });

const asArray = value =>
  value === undefined
    ? []
    : Array.isArray(value)
      ? value
      : [value];

async function discoverSitemapPages() {
  const found = new Set();

  const pending = [
    new URL('/wp-sitemap.xml', origin).toString(),
    new URL('/sitemap_index.xml', origin).toString(),
    new URL('/sitemap.xml', origin).toString()
  ];

  const seen = new Set();

  while (
    pending.length &&
    seen.size < 30 &&
    found.size < maxPages
  ) {
    const sitemap = pending.shift();

    if (seen.has(sitemap)) continue;
    seen.add(sitemap);

    try {
      const sitemapUrl = checkedUrl(sitemap);

      if (sitemapUrl.origin !== origin) continue;

      await validateHost(sitemapUrl.hostname);

      const response = await fetch(sitemapUrl, {
        redirect: 'manual',
        signal: AbortSignal.timeout(15000)
      });

      if (
        !response.ok ||
        (response.status >= 300 && response.status < 400)
      ) {
        continue;
      }

      const xml = parser.parse(await response.text());

      for (const item of asArray(xml.sitemapindex?.sitemap)) {
        const candidate = checkedUrl(item.loc);

        if (
          candidate.origin === origin &&
          !seen.has(candidate.toString())
        ) {
          pending.push(candidate.toString());
        }
      }

      for (const item of asArray(xml.urlset?.url)) {
        const url = withinSite(item.loc);

        if (url) found.add(url);

        if (found.size >= maxPages) break;
      }
    } catch (error) {
      console.log(`Skipping sitemap: ${error.message}`);
    }
  }

  return [...found];
}

// ==================================================
// PRIORITY-BASED PAGE CRAWLING
// ==================================================

// High priority: links discovered directly on pages.
// Low priority: URLs discovered through XML sitemaps.
const internalQueue = [resolvedSite.toString()];
const sitemapQueue = [];

const queued = new Set(internalQueue);
const visited = new Set();
const pages = [];

function enqueue(raw, base, source = 'internal') {
  const url = withinSite(raw, base);

  if (!url) return;

  const parsed = new URL(url);

  // Ignore non-HTML files and WordPress utility URLs.
  if (
    /\.(pdf|jpg|jpeg|png|gif|webp|svg|zip|xml|css|js|mp4|mp3|docx?|xlsx?)$/i.test(parsed.pathname) ||
    /\/wp-admin\/|\/wp-login\.php|\/feed\/|\/wp-json\//i.test(parsed.pathname)
  ) {
    return;
  }

  if (visited.has(url)) return;

  if (source === 'internal') {
    // If this URL was previously discovered in a sitemap,
    // promote it to the higher-priority internal queue.
    const sitemapIndex = sitemapQueue.indexOf(url);

    if (sitemapIndex !== -1) {
      sitemapQueue.splice(sitemapIndex, 1);
      internalQueue.push(url);
      return;
    }
  }

  if (!queued.has(url)) {
    queued.add(url);

    if (source === 'sitemap') {
      sitemapQueue.push(url);
    } else {
      internalQueue.push(url);
    }
  }
}

const browser = await chromium.launch({
  headless: true
});

try {
  // Discover sitemap pages as a supplemental source.
  // These pages will NOT take priority over internal links.
  const sitemapPages = await discoverSitemapPages();

  for (const url of sitemapPages) {
    enqueue(url, undefined, 'sitemap');
  }

  console.log(
    `Discovered ${sitemapQueue.length} sitemap page(s).`
  );

  // Always process internal links before sitemap-only URLs.
  while (
    (internalQueue.length || sitemapQueue.length) &&
    visited.size < maxPages
  ) {
    const url = internalQueue.length
      ? internalQueue.shift()
      : sitemapQueue.shift();

    if (visited.has(url)) continue;

    visited.add(url);

    console.log(
      `Scanning page ${visited.size}/${maxPages}: ${url}`
    );

    const context = await browser.newContext({
      ignoreHTTPSErrors: false,
      serviceWorkers: 'block'
    });

    const page = await context.newPage();

    await page.route('**/*', async route => {
      const request = route.request();

      if (
        request.isNavigationRequest() &&
        !withinSite(request.url())
      ) {
        return route.abort();
      }

      return route.continue();
    });

    try {
      await validateHost(new URL(url).hostname);

      const response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      });

      if (!response || !response.ok()) {
        throw new Error(
          `HTTP ${response?.status() || 'no response'}`
        );
      }

      const finalUrl = withinSite(page.url());

      if (!finalUrl) {
        throw new Error(
          `Redirected outside resolved website: ${page.url()}`
        );
      }

      await page.waitForTimeout(700);

      // Discover internal links from this page.
      // These links are always high priority.
      const links = await page.locator('a[href]').evaluateAll(
        elements => elements.map(a => a.href)
      );

      for (const link of links) {
        enqueue(link, finalUrl, 'internal');
      }

      console.log(
        `Found ${links.length} link(s). ` +
        `${internalQueue.length} internal page(s) queued, ` +
        `${sitemapQueue.length} sitemap page(s) queued.`
      );

      // Run accessibility checks.
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
        url: finalUrl,
        title: await page.title(),
        status: 'scanned',
        violations,
        incompleteCount: result.incomplete.length
      });

      console.log(
        `✓ ${finalUrl}: ${violations.length} rule violations`
      );
    } catch (error) {
      pages.push({
        url,
        title: '',
        status: 'error',
        error: error.message,
        violations: [],
        incompleteCount: 0
      });

      console.log(`✗ ${url}: ${error.message}`);
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
}

// ==================================================
// GENERATE JSON REPORT
// ==================================================

const report = {
  site: resolvedSite.toString(),
  requestedSite: requestedSite.toString(),
  resolvedSite: resolvedSite.toString(),
  scannedAt: new Date().toISOString(),
  scannedPages: pages.filter(
    p => p.status === 'scanned'
  ).length,
  failedPages: pages.filter(
    p => p.status === 'error'
  ).length,
  ruleViolations: pages.reduce(
    (sum, p) => sum + p.violations.length,
    0
  ),
  affectedPages: pages.filter(
    p => p.violations.length
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

// ==================================================
// GENERATE CSV REPORT
// ==================================================

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
  rows.map(
    row => row.map(csvEscape).join(',')
  ).join('\n')
);

console.log(`Report written to ${outputDir}`);

console.log(
  `Completed: ${report.scannedPages} scanned, ` +
  `${report.failedPages} failed, ` +
  `${report.ruleViolations} rule violations`
);
