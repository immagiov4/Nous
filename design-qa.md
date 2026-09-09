# Initial configuration — visual verification

## Result

Visual check passed for the observed desktop dark and mobile light preferences screens. The implementation uses the existing logo, colors, fonts and single theme button. The approved reference is a generated composite, so this is a layout and interaction comparison, not a pixel-exact match.

The user's subsequent directions supersede two details in the reference: the segmented theme selector is replaced by the existing sun/moon button, and the review step is removed. The flow now contains languages and preferences, followed by direct entry into the application.

## Evidence

Reference: [approved reference](docs/assets/account-setup/reference.png).

Actual captures, compared alongside the reference:

- [mobile light capture](docs/assets/account-setup/mobile-light.png) — browser viewport measured at 390 × 845 CSS pixels.
- [desktop dark capture](docs/assets/account-setup/desktop-dark.png) — browser viewport measured at 1440 × 1023 CSS pixels.

The observed mobile layout has no horizontal overflow. Heading, subtitle, textarea and action remain separated and readable. The language selector now uses a 20-pixel chevron with a 16-pixel right inset and reserved text padding. This replaces the browser's small edge-aligned indicator while preserving native selection behavior.

## Behavioral validation and limits

35 focused tests passed across setup flow, account gate, existing preferences panel and account routes. They cover direct completion, skipping, failed saves and retries, pending-operation controls, browser-language preview, enrollment and account switching. Frontend and backend type checks passed; scoped Biome checks passed after formatting.

After repairing Docker's temporary sockets, the actual migration and persistence tests passed against an isolated PostgreSQL 17 container: 40 tests passed across the five focused files. Enrollment, completion, skipping, transaction rollback and direct-client access restrictions were verified. No shared database migration or deployment was performed. The development demonstration uses an in-memory adapter and restarts after completion.
