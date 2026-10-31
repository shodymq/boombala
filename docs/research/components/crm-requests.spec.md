# CRM requests specification

## Reference and appearance

- Source: `dashboard-aminpanek/src/App.vue` requests section and `src/styles.css` selectors `.requests-workspace`, `.request-tabs`, `.requests-head`, `.request-row`, `.request-client`, `.status-pill`, `.request-detail`.
- The browser reference at `http://localhost:5173/` shows page title and description, four summary cards, a white rounded queue surface, compact status tabs, search/branch control, column headers and rows. Selected row has a subtle warm tint; rows are separated by fine neutral borders; status is a small colored pill.
- Source queue surface uses warm/light canvas, white card, rounded 14–20 px surfaces, compact DM Sans text and bold Manrope titles. Adapt orange primary/active controls to purple `#3B1E78`; keep semantic status colors.

## Target structure and content

- Preserve existing `/requests` search, status/date filters, existing permissions, FastAPI/legacy source boundary, empty/error messages, booking confirmation, and status actions.
- Display only actual CRM records and available fields: request ID, contact name/phone, creation/request date, package, guest count, source/branch when present, and actual status.
- Do not copy the source demo summary counts, customers, time labels, branch selector, or manager-only fields. Do not show summary metrics unless computed from current query/data and consistent with existing filters.
- Detail actions stay available only where the current CRM permits them. No fake drawer or unsupported data editing.

## Interaction model

- Existing filters submit via GET; status/action forms keep their current server actions and rules.
- Source tabs switch client-side state. Target keeps GET-based status filtering and represents available status choices with the same rounded pill/tab visual style.
- A row expands only if an existing target interaction supports it; do not invent request editing.

## Responsive behavior

- At tablet/mobile widths, hide desktop column headings and present each request as a stacked card, preserving status, date, and primary actions.
- Search and filters wrap into one column; no horizontal overflow.
