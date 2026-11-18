# CRM design assets: provenance and licences

Status of every third-party asset shipped with the CRM design (`platform/public/icons`, `platform/public/illustrations`).
**Not legally cleared yet**: the repository carries no licence record for either set, and this file does not invent one.

| Asset | Where | What the repository shows | What must be confirmed before production |
| --- | --- | --- | --- |
| 17 PNG icons (`bell`, `calendar`, ...) | `platform/public/icons/flaticon/` | Named after Flaticon and credited as «Designed by Flaticon» in the sidebar. No receipt, pack name or author is recorded. | Which Flaticon pack and author each icon comes from, and that the account used has a licence that allows commercial use with the attribution shown (free plan requires attribution per author; Premium does not). Replace with an owned or open-licence set (for example Lucide, ISC) if this cannot be shown. |
| 3 SVG illustrations (`milano-*.svg`) | `platform/public/illustrations/` | Credited as «Illustrations by Streamline»; the source link is the Figma Community file «1-600 Free Illustrations» (URL in `src/app/(admin)/layout.tsx`). | The licence stated on that Community page (Streamline free illustration packs are normally CC BY 4.0, which requires attribution and a link to the licence). The sidebar credit links to Flaticon and the Figma source only; add the licence name and link once confirmed. |

Why this matters: an icon or illustration without a provable licence is a liability, not a design detail. Merge only after
both rows are filled in with a licence name, a link and the account or author. Until then the credits in the sidebar stay.
The assets are public files served without authentication (they contain no data); the proxy lets them through only after the
exposure checks (role, host, network).
