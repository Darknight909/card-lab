# Card Lab v2.0 — GitHub Pages frontend

Card Lab 2.0 replaces the incremental v1 identification workflow with a single evidence pipeline.

## Automatic workflow
1. Front and back photos are saved locally in IndexedDB.
2. Card Lab detects/crops the card and measures centering locally on the phone.
3. The Worker sends analysis copies to Google Cloud Vision for Web Detection + OCR.
4. The Worker verifies the resulting identity clues with Tavily text/web results.
5. Cloudflare Workers AI inspects visible corners, edges, surface and print/focus condition only.
6. Card Lab calculates PSA/BGS/CGC/SGC pre-grade estimates locally only when condition and centering are reliable.
7. Current eBay listing results are loaded automatically when available.
8. The completed record and photos stay in the phone's local collection.

## Important changes from v1.8
- Google visual-web matching is the primary identity source rather than a generic vision-model guess.
- Exact OCR card codes are treated as stronger evidence than jersey numbers or statistics years.
- Centering is calculated locally and withheld when the design borders cannot be measured reliably.
- Draft analysis results are cached locally, so reopening/updating the app does not automatically spend another online analysis request.
- Take Photo and Photo Library remain separate controls; hidden file inputs eliminate the misleading iOS “no file selected” display.
- Front/back analysis images use a higher-resolution detected card crop.
- No grade is shown when the evidence needed to support it is missing.

## Update existing GitHub Pages app
Upload/replace all files in the root of the existing `card-lab` repository and commit.
Do not delete/re-add the iPhone Home Screen app. Open the installed app and use Settings → Check for update if it does not refresh automatically.

## Privacy
Collection records and saved card photos remain in local browser storage. Analysis copies are sent transiently through the user's Worker to Google Cloud Vision and Cloudflare Workers AI. Tavily receives text/search clues, not card images. The supplied Worker does not persist cards/photos in KV, R2, D1, or Durable Objects.

## Grading limitation
This is a pre-grade estimate. Phone photos cannot rule out microscopic scratches, indentations, trimming, restoration, surface texture, or other in-hand inspection factors used by professional graders.
