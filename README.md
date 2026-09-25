# Card Grade & Collection Lab — PWA v1

A private, installable web app for iPhone that:

- Captures front/back card photos from the phone camera.
- Compresses and stores card photos locally in IndexedDB.
- Estimates grades against published PSA, Beckett/BGS, CGC Cards and SGC criteria.
- Tracks card details, acquisition cost, notes and grade estimates in a local collection.
- Opens a current eBay listing search generated from the card metadata.
- Exports/imports a JSON backup including card images.
- Works offline after first load through a service worker.

## Important grading limitation

This is a **pre-grading aid**, not a professional grading service. Published company standards do not expose every internal weighting/judgment rule. Phone photos also cannot reliably reveal every indentation, alteration, surface defect, gloss issue or authenticity concern. The app therefore combines photo-quality checks, centering measurements and a manual physical-inspection checklist.

For high-value cards, use strong diffused light plus angled inspection light and magnification before relying on the estimate.

## Free deployment (needed for iPhone installation)

A PWA needs HTTPS (or localhost) for service workers/installability. The easiest no-cost options are GitHub Pages, Cloudflare Pages, or Netlify.

### GitHub Pages
1. Create a free GitHub account/repository if needed.
2. Upload all files in this folder to the repository root.
3. Repository Settings → Pages → Deploy from branch → `main` / root.
4. Open the resulting HTTPS URL on the iPhone.
5. In DuckDuckGo, use Add to Home Screen if offered. If it is not offered, open the same URL once in Safari → Share → Add to Home Screen → Open as Web App.

No app-store account is needed.

## eBay current listings

The free version uses a one-tap live eBay search rather than scraping eBay pages. This avoids brittle scraping/CORS issues and does not expose an eBay developer secret in browser code.

A later version can show live listings inside the app by adding a small serverless eBay Browse API proxy. Never put an eBay client secret directly in `app.js`.

## Grading standards referenced

Reviewed September 2026:

- PSA: https://www.psacard.com/gradingstandards
- Beckett/BGS: https://www.beckett.com/grading/scale
- CGC Cards: https://www.cgccards.com/card-grading/grading-scale/
- SGC: https://www.gosgc.com/card-grading/scale

The app uses standards as **caps/guidelines**, not as a claim of affiliation or official grading.

## Privacy

The v1 app has no analytics and no account system. Collection data and photos remain in the browser's local IndexedDB unless you export a backup or follow an external eBay search link.
