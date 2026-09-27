# Card Lab v8.0.0 — GitHub Pages frontend

Card Lab 5.0 is a major optimization release focused on accuracy, stage isolation, manual collection control, speed, and regression protection.

## Major workflow changes
- Analysis never adds a card to Collection automatically.
- After analysis, **Add to Collection** appears for new cards; saved cards show **Update Collection**.
- Verified and unverified cards can both be saved manually, with verification status preserved.
- Editing identity before saving records the correction locally as a regression case instead of silently overwriting the automated result.
- Exact-photo duplicate detection asks before updating an existing physical card.

## Accuracy / efficiency
- Front/back identity copies receive mild non-destructive normalization for OCR while condition analysis still uses the original cropped images.
- Verified identity can be reused even for an unsaved scan, so re-analysis does not repeat identification unnecessarily.
- A valid condition result can be reused during Re-identify, avoiding duplicate condition calls.
- **Retry condition only** calls the dedicated backend condition endpoint without rerunning identity or eBay.
- Local verified-card fingerprints provide hints to future identification but never bypass online verification.
- Local stage telemetry tracks recent analysis timing so bottlenecks can be measured instead of guessed.

## Reference intelligence
- Verified identities are cached locally as reusable fingerprints.
- Manual identity corrections are captured locally as regression cases and trusted hints for future matching.
- Full recovery exports include reference cache, regression cases, and telemetry.

## Collection
- Price Paid and Purchase Date remain editable.
- Collection shows verification status.
- Collection summary shows total raw value, total paid, and value-vs-paid difference.
- Raw Card Value remains prominent on the main analysis page.

## Diagnostics
- Backend field confidence/evidence graph remains visible.
- Diagnostics now include local reference-cache size, captured regression-case count, performance averages, local trusted-hint use, and stage-reuse information.
- Regression cases can be exported from Settings.

## Update
Replace the files in the root of the existing `card-lab` GitHub repository and commit. Do not delete the Home Screen app.

Then open Card Lab → Settings → Check for update.

The header should show `v5.0.0`.


## v5.0.1 camera reliability update
- On iPhone/PWA, the photo buttons use the native system camera instead of an embedded getUserMedia camera.
- This preserves full native focus/exposure behavior and avoids guided-camera launch/capture failures.
- Existing post-capture photo-quality checks remain active.

## v6.0.0 optimization pass
- Core card identity can be trusted for pre-grading even while a parallel remains unresolved; market valuation stays blocked until the variant is safe.
- High-confidence independent centering can rescue a failed local geometry measurement.
- Condition results consume deterministic severity-to-score mapping from API v6 instead of trusting raw model numeric grades.
- Native iPhone Take Photo workflow remains the default.

## v7.0.0 verified-source-first release
- Identity is finalized from trusted online sources; photo AI/OCR supplies search clues only.
- Full card-number matching rejects prefix false positives.
- Verified reference centering is the only automatic rescue path when local geometry fails.
- Extreme centering is fail-closed.
- Condition remains deterministic after categorical vision inspection.

## v8.0.0 consolidated grading-pipeline rebuild
- Creates a local labeled inspection sheet from each photo: full card plus enlarged corner and edge regions.
- Sends those sheets only to the condition stage; identity still uses normalized physical-card photos and verified online sources.
- Existing deterministic grading-company rules remain unchanged.
- Native iPhone Take Photo remains the default.
- Collection saving remains manual.
