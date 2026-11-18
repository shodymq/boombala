# CRM design assets: provenance and licences

| Asset | Where | Licence | Status |
| --- | --- | --- | --- |
| Interface icons | `lucide-react` 1.75.0 (npm), rendered as inline SVG by `platform/src/components/icon.tsx` | ISC, https://lucide.dev/license (the npm package declares `ISC`). Three icons are also saved as SVG files for CSS backgrounds: `platform/public/icons/lucide/` (generated from the same package). | Cleared. The ISC text requires keeping the copyright notice with copies: it ships in `node_modules/lucide-react/LICENSE` and the sidebar links to the licence. |
| Decorative artwork | `platform/src/components/brand-art.tsx` | Drawn for this project from plain shapes; no third-party material. | Cleared (owned). |

Removed in this change: the 17 PNG icons labelled Flaticon and the 3 Streamline illustrations from the Figma Community file.
No licence for them could be shown in the repository. Do not restore them without a written licence record.
