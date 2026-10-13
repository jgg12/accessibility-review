
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

// Only allow public Penn State HTTPS domains.
function isPennStateHost(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return host === 'psu.edu' || host.endsWith('.psu.edu');
}

function validateUrl(raw, base) {
  let url;

  try {
    url = new URL(raw, base);
  } catch {
    throw new Error(`Invalid URL: ${raw}`);
  }

  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    !isPennStateHost(url.hostname)
  ) {
    throw new Error(`URL is not an approved Penn State HTTPS URL: ${url}`);
  }

  url.hash = '';
  return url;
}

const requestedSite = validateUrl(siteInput);

if (requestedSite.hostname !== 'sites.psu.edu') {
  throw new Error(
    'The starting URL must be a sites.psu.edu website.'
  );
}

function isPrivate(ip) {
  const version = net.isIP(ip);

  if (version === 4) {
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
      (p[0] === 198 && (p[1] === 18 || p[1] === 19))
    );
  }

  if (version === 6) {
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
  if (!isPennStateHost(hostname)) {
    throw new Error(`Unauthorized hostname: ${hostname}`);
  }

  const addresses = await dns.lookup(hostname, { all: true });

  if (!addresses.length || addresses.some(a => isPrivate(a.address))) {
    throw new Error(
      `Hostname resolves to a non-public address: ${hostname}`
    );
  }
}

// Follow approved Penn State redirects manually.
async function resolveRedirects(input, maxRedirects = 8) {
  let current = validateUrl(input);

  for (let i = 0; i <= maxRedirects; i++) {
    await validateHost(current.hostname);

    const response = await fetch(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
      headers: {
        'User-Agent': 'CEI-Accessibility-Scanner/0.2'
      }
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');

      if (!location) {
        throw new Error('Redirect has no Location header.');
      }

      const next = validateUrl(location, current);
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

console.log(`Requested site: ${requestedSite}`);
console.log(`Resolved destination: ${resolvedSite}`);

const origin = resolvedSite.origin;

// When a site uses its own domain, stay on that domain.
// When it stays on sites.psu.edu, stay within its site path.
function normalizePath(pathname) {
  const decoded = decodeURIComponent(pathname);
  return decoded.replace(/\/+/g, '/');
}

const requestedPath = normalizePath(requestedSite.pathname);
const resolvedPath = normalizePath(resolvedSite.pathname);

const sitePath =
  resolvedSite.hostname === 'sites.psu.edu'
    ? (resolvedPath.endsWith('/')
        ? resolvedPath
        : `${resolvedPath}/`)
    : '/';

function withinSite(raw, base = origin) {
  try {
    const url = validateUrl(raw, base);

    if (url.origin !== origin) return null;

    if (sitePath !== '/') {
      const pathname = normalizePath(url.pathname);
      const root = sitePath.slice(0, -1);

      if (pathname !== root && !pathname.startsWith(sitePath)) {
        return null;
      }
    }

    return url.toString();
  } catch {
    return null;
  }
}

// Sitemap discovery.
const parser = new XMLParser({ ignoreAttributes: false });

const asArray = value =>
  value === undefined
    ? []
    : Array.isArray(value)
      ? value
      : [value];

async function safeFetch(raw) {
  const url = withinSite(raw);

  if (!url) {
    throw new Error('URL is outside the resolved website.');
  }

  await validateHost(new URL(url).hostname);

  const response = await fetch(url, {
    redirect: 'manual',
    signal: AbortSignal.timeout(15000),
    headers: {
      'User-Agent': 'CEI-Accessibility-Scanner/0.2'
    }
  });

  if (response.status >= 300 && response.status < 400) {
    throw new Error('Sitemap redirect rejected.');
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.text();
}

async function discover() {
  const urls = new Set([withinSite(resolvedSite.toString())]);

  const sitemapPaths = [
    '/wp-sitemap.xml',
    '/sitemap_index.xml',
    '/sitemap.xml'
  ];

  const pending = sitemapPaths.map(
    p => new URL(p, origin).toString()
  );

  // Also check site-specific sitemap paths when applicable.
  if (sitePath !== '/') {
    for (const filename of sitemapPaths) {
      const candidate = withinSite(
        filename.slice(1),
        resolvedSite.toString().replace(/\/?$/, '/')
      );

      if (candidate) pending.push(candidate);
    }
  }

  const seen = new Set();

  while (
    pending.length &&
    seen.size < 30 &&
    urls.size < maxPages
  ) {
    const sitemap = pending.shift();

    if (seen.has(sitemap)) continue;
    seen.add(sitemap);

    // Root-level sitemaps may be necessary to discover
    // sites.psu.edu subsite URLs.
    const isRootSitemap = sitemapPaths.some(
      p => sitemap === new URL(p, origin).toString()
    );

    if (!withinSite(sitemap) && !isRootSitemap) {
      continue;
    }

    try {
      let xmlText;

      if (isRootSitemap && !withinSite(sitemap)) {
        await validateHost(new URL(sitemap).hostname);

        const response = await fetch(sitemap, {
          redirect: 'manual',
          signal: AbortSignal.timeout(15000)
        });

        if (!response.ok || response.status >= 300 && response.status < 400) {
          continue;
        }

        xmlText = await response.text();
      } else {
        xmlText = await safeFetch(sitemap);
      }

      const xml = parser.parse(xmlText);

      for (const item of asArray(xml.sitemapindex?.sitemap)) {
        const link = withinSite(item.loc);

        if (link && !seen.has(link)) {
          pending.push(link);
        }
      }

      for (const item of asArray(xml.urlset?.url)) {
        const link = withinSite(item.loc);

        if (
          link &&
          !/\.(pdf|jpg|jpeg|png|gif|webp|zip|xml)(\?|$)/i.test(link)
        ) {
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

  return [...urls].filter(Boolean).slice(0, maxPages);
}

const urls = await discover();

console.log(`Scanning ${urls.length} page(s) on ${origin}`);

const browser = await chromium.launch({
  headless: true
});

const pages = [];

try {
  for (const url of urls) {
    const context = await browser.newContext({
      ignoreHTTPSErrors: false,
      serviceWorkers: 'block'
    });

    const page = await context.newPage();

    // Prevent navigation outside the resolved site.
    await page.route('**/*', async route => {
      const request = route.request();

      if (request.isNavigationRequest()) {
        const destination = withinSite(request.url());

        if (!destination) {
          return route.abort();
        }
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

      if (!withinSite(page.url())) {
        throw new Error(
          `Page redirected outside the resolved site: ${page.url()}`
        );
      }

      await page.waitForTimeout(700);

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
        url: page.url(),
        title: await page.title(),
        status: 'scanned',
        violations,
        incompleteCount: result.incomplete.length
      });

      console.log(
        `✓ ${page.url()}: ${violations.length} rule violations`
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

// Build report using the existing dashboard schema.
const report = {
  site: resolvedSite.toString(),
  requestedSite: requestedSite.toString(),
  resolvedSite: resolvedSite.toString(),
  scannedAt: new Date().toISOString(),
  scannedPages: pages.filter(p => p.status === 'scanned').length,
  failedPages: pages.filter(p => p.status === 'error').length,
  ruleViolations: pages.reduce(
    (total, p) => total + p.violations.length,
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
