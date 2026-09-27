# Card Lab v3.0.1 — GitHub Pages frontend

Card Lab 3.0.1 is a stabilization update to the v3 full-system architecture focused on verified identity, conservative pre-grading, usable current-market results, and durable collection history.

## What changed from v3.0
- Automatic centering more extreme than 70/30 is withheld unless independently corroborated by the backend vision estimate.
- This prevents internal artwork/design lines from being accepted as high-confidence printed borders.
- No collection schema or saved-card format changes.

## Core workflow
1. Front and back photos are saved locally on the phone.
2. A photo-quality gate checks blur/glare/card isolation before spending online analysis calls.
3. Google Cloud Vision extracts OCR and visual-web clues.
4. The Worker searches trusted card/checklist sources and accepts an exact identity only after deterministic evidence gates pass.
5. The verified identity is locked for saved cards. Normal Re-analyze does not re-identify the card.
6. Card Lab measures centering locally and cross-checks it against independent vision evidence. If those disagree materially, the grade is withheld rather than guessed.
7. Cloudflare Workers AI inspects visible corners, edges, surface, focus, and defects.
8. PSA/BGS/CGC/SGC pre-grade estimates are calculated locally only when required evidence is reliable.
9. eBay market data refreshes automatically. When eBay Browse API credentials are connected, results are live structured listings with direct links, current asking prices, shipping, condition, seller information, and raw/graded filtering.
10. Exact verified cards auto-save locally. Re-analysis updates the same card and creates a separate dated analysis-history snapshot.

## Collection and history
- Tap a saved card to reopen its photos, identity, grade, centering, condition, market data, and history.
- Re-analyze keeps the verified identity locked and refreshes condition, grade, and market.
- Re-identify explicitly runs the identity pipeline again if the original identification is wrong.
- Each analysis creates an independent dated history snapshot.
- A single history entry can be deleted without deleting the card or other history entries.
- Photo versions are deduplicated by an exact local SHA-256 content hash to reduce storage use.
- Automatic duplicate-record merging occurs only when the exact same saved front/back image bytes are reused. Visually similar cards are never auto-merged because they may be separate physical copies.

## Identity rules
AI/OCR may extract clues, but it is not the source of truth for card identity. Exact identity must be corroborated by trusted online sources. Date-shaped text such as birth dates is rejected as a card-number candidate. Exact alphanumeric card codes are weighted strongly and must match source evidence.

## Privacy
The collection, saved photos, and history remain in local browser storage. Analysis images are transmitted transiently to Google Cloud Vision and Cloudflare Workers AI. Tavily receives text/search clues only. If official eBay image search is enabled, the front analysis image is also sent transiently to eBay. The Worker does not persist the collection or card photos.

## Update existing app
Upload/replace the files in the root of the existing `card-lab` GitHub repository and commit. Do not delete or reinstall the iPhone Home Screen app. Open Card Lab and use Settings → Check for update if the new shell does not load automatically.

## Grading limitation
Card Lab is a pre-grading tool. Phone photographs cannot rule out all microscopic scratches, indentations, alterations, texture defects, or in-hand eye-appeal factors used by professional graders.
