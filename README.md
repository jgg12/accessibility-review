# Accessibility Review

A Penn State-inspired static dashboard plus automated WordPress accessibility scanning using Node.js, Playwright, axe-core and GitHub Actions.

## Deployment

1. Create a **public** GitHub repository named `accessibility-review` under your authorized CEI organization. Upload the files in this directory to the repository root. Do not upload the outer folder.
2. In `docs/app.js`, replace `REPLACE_ORG/accessibility-review` with `YOUR-CEI-ORG/accessibility-review`.
3. In GitHub **Settings → Pages**, select **Deploy from a branch**, branch `main`, folder `/docs`.
4. In GitHub **Settings → Actions → General → Workflow permissions**, enable **Read and write permissions** so the workflow can commit reports. Confirm your organization's policies permit this.
5. Create a GitHub label named `accessibility-review` (exact spelling). Enable Issues for the repository. The issue form is in `.github/ISSUE_TEMPLATE`.
6. Open your Pages URL: `https://YOUR-CEI-ORG.github.io/accessibility-review/`.
7. Enter an HTTPS `sites.psu.edu` URL and click **Review site**. GitHub opens a preconfigured issue form. Paste the copied URL if needed and **submit the issue**. This is the required GitHub sign-in and confirmation step. An Action runs automatically for a properly labeled issue.
8. After the Action completes and GitHub Pages refreshes, reload the dashboard to see results and download CSV. Alternatively, go to **Actions → Accessibility review → Run workflow** to enter the URL directly (repository collaborators only).

## Important architecture limitation

GitHub Pages is static and **cannot run a server-side browser scan from a single public button click**. This implementation uses GitHub Issues as a safe, authenticated trigger. The visitor must submit a GitHub issue after clicking Review site. A true one-click scan and live progress indicator require a separate backend service with authentication, rate limiting and secure GitHub token storage. Never embed a GitHub token in browser JavaScript.

## Scope and privacy

- Scans only public HTTPS `sites.psu.edu` hosts. Maximum 25 sitemap-discovered pages per run.
- Use only on websites you own or are authorized to test. The scanner runs browser requests and should be used responsibly.
- The dashboard shows **the latest completed scan**, not per-site history. Reports are public in a public repository.
- axe-core findings do not establish WCAG compliance; manually verify alt text quality, keyboard access, interactive states, screen reader behavior and authenticated areas.
- Issue-submitted URLs and public reports are visible to repository visitors. Do not submit private sites.
- The issue workflow accepts requests from GitHub users who can open issues; consider restricting Issues access, adding approval, or using manual-only workflows if abuse becomes a concern.
- If you are not using `main` as the default branch, adjust GitHub Pages settings accordingly.

## Development

```bash
npm install
npx playwright install chromium
ALLOW_SITES_SUBDOMAINS=true SITE_URL=https://example.sites.psu.edu MAX_PAGES=5 npm run scan
npx http-server docs -p 8080
```

Node.js 22 recommended. Requires network access to the website during scans. The included report is empty until a real scan completes.

## Official resources

- https://accessibility.psu.edu/
- https://accessibility.psu.edu/images/alttext/
- https://accessibility.psu.edu/headings/
- https://accessibility.psu.edu/linktext/
- https://accessibility.psu.edu/testing/testingtools/

Design is inspired by supplied screenshots and Penn State colors. This is a CEI project concept, not an official Penn State-branded application until branding is approved.
