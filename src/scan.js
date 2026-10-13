import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { XMLParser } from 'fast-xml-parser';
import fs from 'node:fs/promises';
import path from 'node:path';
import dns from 'node:dns/promises';
import net from 'node:net';

const siteInput = process.env.SITE_URL || process.argv[2];
const maxPages = Math.min(Math.max(Number(process.env.MAX_PAGES || 25), 1), 100);
const outputDir = path.resolve('docs');
if (!siteInput) throw new Error('Set SITE_URL or pass a website URL.');
const site = new URL(siteInput);
if (site.protocol !== 'https:') throw new Error('Only HTTPS websites are supported.');
if (site.username || site.password || site.port) throw new Error('Credentials and custom ports are not supported.');
const allowed = (process.env.ALLOWED_HOSTS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
if (!allowed.length) throw new Error('Set ALLOWED_HOSTS to a comma-separated list of authorized exact hostnames.');
if (!allowed.includes(site.hostname.toLowerCase()) && !(process.env.ALLOW_SITES_SUBDOMAINS === 'true' && (site.hostname.toLowerCase() === 'sites.psu.edu' || site.hostname.toLowerCase().endsWith('.sites.psu.edu')))) throw new Error(`Host ${site.hostname} is not authorized.`);

function isPrivate(ip) {
  if (net.isIP(ip) === 4) {
    const p = ip.split('.').map(Number);
    return p[0] === 0 || p[0] === 10 || p[0] === 127 || p[0] >= 224 ||
      (p[0] === 169 && p[1] === 254) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168) || (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||
      (p[0] === 192 && p[1] === 0 && p[2] === 0) || (p[0] === 198 && (p[1] === 18 || p[1] === 19));
  }
  if (net.isIP(ip) === 6) {
    const s = ip.toLowerCase();
    return s === '::1' || s === '::' || s.startsWith('fc') || s.startsWith('fd') || s.startsWith('fe8') || s.startsWith('fe9') || s.startsWith('fea') || s.startsWith('feb') || s.startsWith('::ffff:');
  }
  return true;
}
async function validateHost() {
  const addresses = await dns.lookup(site.hostname, { all: true });
  if (!addresses.length || addresses.some(a => isPrivate(a.address))) throw new Error('Target hostname resolves to a non-public address.');
}
await validateHost();
const origin = site.origin;
function sameOriginUrl(raw, base = origin) {
  try {
    const u = new URL(raw, base);
    if (u.origin !== origin || u.protocol !== 'https:' || u.username || u.password) return null;
    u.hash = '';
    return u.toString();
  } catch { return null; }
}
async function safeFetch(url) {
  const u = sameOriginUrl(url);
  if (!u) throw new Error('Cross-origin URL rejected.');
  await validateHost();
  const response = await fetch(u, { signal: AbortSignal.timeout(15000), redirect: 'manual', headers: { 'User-Agent': 'CEI-Accessibility-Scanner/0.1' } });
  if (response.status >= 300 && response.status < 400) throw new Error('Redirected sitemap rejected.');
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}
const parser = new XMLParser({ ignoreAttributes: false });
const asArray = v => v === undefined ? [] : Array.isArray(v) ? v : [v];
async function discover() {
  const urls = new Set([sameOriginUrl(site.toString())]);
  const pending = [new URL('/wp-sitemap.xml', origin).toString(), new URL('/sitemap_index.xml', origin).toString(), new URL('/sitemap.xml', origin).toString()];
  const seen = new Set();
  while (pending.length && seen.size < 30 && urls.size < maxPages) {
    const sitemap = pending.shift();
    if (!sameOriginUrl(sitemap) || seen.has(sitemap)) continue;
    seen.add(sitemap);
    try {
      const xml = parser.parse(await safeFetch(sitemap));
      for (const item of asArray(xml.sitemapindex?.sitemap)) {
        const link = sameOriginUrl(item.loc);
        if (link && !seen.has(link)) pending.push(link);
      }
      for (const item of asArray(xml.urlset?.url)) {
        const link = sameOriginUrl(item.loc);
        if (link && !/\.(?:pdf|jpg|jpeg|png|gif|webp|zip|xml)(?:\?|$)/i.test(link)) urls.add(link);
        if (urls.size >= maxPages) break;
      }
    } catch (e) { console.log(`Skipping sitemap ${sitemap}: ${e.message}`); }
  }
  return [...urls].slice(0, maxPages);
}
const urls = await discover();
console.log(`Scanning ${urls.length} page(s) on ${origin}`);
const browser = await chromium.launch({ headless: true });
const pages = [];
try {
  for (const url of urls) {
    const context = await browser.newContext({ ignoreHTTPSErrors: false, serviceWorkers: 'block' });
    const page = await context.newPage();
    await page.route('**/*', async route => { const req=route.request(); if (req.isNavigationRequest() && !sameOriginUrl(req.url())) return route.abort(); return route.continue(); });
    // Prevent navigation to non-target hosts; normal assets can still load.
    page.on('framenavigated', frame => {
      if (frame === page.mainFrame() && frame.url().startsWith('http') && !sameOriginUrl(frame.url())) page.close().catch(() => {});
    });
    try {
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      if (!response || !response.ok()) throw new Error(`HTTP ${response?.status() || 'no response'}`);
      await page.waitForTimeout(700);
      const result = await new AxeBuilder({ page }).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa']).analyze();
      pages.push({ url, title: await page.title(), status: 'scanned', violations: result.violations.map(v => ({ id:v.id, impact:v.impact, description:v.description, help:v.help, helpUrl:v.helpUrl, nodes:v.nodes.map(n => ({ target:n.target, html:n.html, failureSummary:n.failureSummary })) })), incompleteCount: result.incomplete.length });
      console.log(`✓ ${url}: ${result.violations.length} rule violations`);
    } catch (error) {
      pages.push({ url, title: '', status: 'error', error: error.message, violations: [], incompleteCount: 0 });
      console.log(`✗ ${url}: ${error.message}`);
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
const report = { site: origin, scannedAt: new Date().toISOString(), scannedPages: pages.filter(p=>p.status==='scanned').length, failedPages: pages.filter(p=>p.status==='error').length, ruleViolations: pages.reduce((n,p)=>n+p.violations.length,0), affectedPages: pages.filter(p=>p.violations.length).length, pages };
await fs.mkdir(outputDir, { recursive:true });
await fs.writeFile(path.join(outputDir,'report.json'), JSON.stringify(report,null,2));
const csvEscape = s => `"${String(s ?? '').replaceAll('"','""')}"`;
const rows = [['page','status','rule_id','impact','description','affected_elements','help_url','error']];
for (const p of pages) {
  if (!p.violations.length) rows.push([p.url,p.status,'','','','','',p.error||'']);
  for (const v of p.violations) rows.push([p.url,p.status,v.id,v.impact,v.help,v.nodes.length,v.helpUrl,'']);
}
await fs.writeFile(path.join(outputDir,'report.csv'), rows.map(r=>r.map(csvEscape).join(',')).join('\n'));
console.log(`Report written to ${outputDir}`);
