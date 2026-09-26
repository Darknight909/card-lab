# Card Lab v1.2 — GitHub Pages frontend

## What changed
- Front + back photos can now be sent to your private Cloudflare Worker for automatic card identification and visible-condition analysis.
- The app auto-fills year, set, subject, card number, variation, category, centering, condition scores and visible defects.
- PSA/BGS/CGC/SGC pre-grade estimates are then calculated automatically from the published-standard rules in the app.
- Current eBay search is built automatically. If eBay API secrets are configured on the Worker, the backend also uses current listing titles as identity corroboration.
- Backend settings (Worker URL + private API key) are stored only in the browser on your phone.
- Collection/photos remain in local IndexedDB. The Worker does not persist the submitted photos.
- Service worker changed to network-first for core app files so future updates should refresh more reliably.

## Update GitHub Pages
Upload all files in this folder to the root of the existing `card-lab` repository and commit them. Keep GitHub Pages on the `main` branch root.

## First run
Open Card Lab > Settings and enter:
1. Your Cloudflare Worker URL
2. The same `CARDLAB_API_KEY` value you configured as a Worker secret

Tap Test connection. Then return to Grade, take front/back photos, and tap Analyze card automatically.

## Important
This remains a pre-grade estimate. Phone photos and AI cannot reliably detect every dent, micro-scratch, alteration, restoration, trimming issue, or in-hand eye-appeal factor used by professional graders.
