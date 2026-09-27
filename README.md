# Card Lab v4.0.0 — GitHub Pages frontend

Card Lab 4.0 is a full optimization release focused on accuracy, efficiency, usability, and regression protection.

## Major changes
- Raw card value is now prominent on the main Grade page.
- Raw value uses the backend's trimmed current-market estimate, credible range, sample size, and market-support quality.
- Price Paid and Purchase Date are permanent card-level fields.
- Purchase details can be edited directly from the Collection page without rerunning analysis.
- Collection cards show raw value, price paid, purchase date, and value-vs-paid difference when available.
- Backup schema advances to v5 while importing older `cost` data into Price Paid automatically.
- Identity results now show per-field confidence and explicit parallel/variation gate status.
- v3 saved cards containing a variation are forced through one v4 re-identification so an old parallel guess cannot remain locked.
- Analysis requests send local photo-quality measurements to the backend for condition-confidence calibration.
- Analysis crops are modestly higher resolution for OCR/serial-number recovery.
- Diagnostic mode shows field confidence, evidence graph, stage timing, model path, photo quality, and pipeline information.
- Diagnostic mode can run the backend deterministic regression self-test.

## Existing v3 architecture preserved
- Local IndexedDB collection/photos/history
- Verified-identity lock
- Re-identify vs Re-analyze separation
- Local centering measurement with vision disagreement guard
- Raw / graded / all market tabs
- Independent `Refresh eBay only`
- Dated analysis snapshots and individual history deletion
- Exact-photo duplicate protection
- Full collection backup and full recovery
- In-place PWA updates

## Update existing app
Replace the files in the root of the existing `card-lab` GitHub repository and commit. Do not delete the Home Screen app.

Then open Card Lab → Settings → Check for update.

The header should show `v4.0.0`.
