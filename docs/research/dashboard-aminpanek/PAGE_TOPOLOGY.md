# Snow UI source to Boom Bala CRM

## Source

- Visual source: `/Users/aspanch1k/Documents/ChatGPT/dashboard-aminpanek`, Vue/Vite local design prototype.
- Source files: `src/App.vue`, `src/styles.css`, `src/assets/figma-snowui-illustration-006.svg`.
- Browser reference: `http://localhost:5173/`.
- The source overview and requests screen were inspected in the browser at a 1280 px desktop viewport. Its source data is prototype data and is not to be copied.

## Shared shell

1. White left sidebar with BoomBala mark/name, two uppercase navigation groups, icon links, rounded selected item, signed-in user at the bottom.
2. White 76 px topbar with workspace/page breadcrumb on the left and compact search/profile controls on the right.
3. Warm near-white page canvas. At desktop, content starts after a 254 px sidebar and uses a centered 1440 px maximum width with 42 px horizontal padding.
4. At tablet/mobile widths, use the source's collapsible sidebar pattern and stack page content. Preserve keyboard-accessible navigation.

## CRM route map

| CRM route | Source visual pattern |
| --- | --- |
| `/` | Overview greeting, KPI cards, compact panels |
| `/requests` | Requests queue, filters, request rows/details |
| `/bookings` | Ticket/catalog card and data-table patterns |
| `/attendance` | KPI, filters, chart/data-table patterns |
| `/contacts`, `/contacts/[id]` | Client table and record-detail patterns |
| `/news`, `/news/new`, `/news/[id]`, `/news/media` | Content cards and editor forms |
| `/legal`, `/retention`, `/users`, `/audit`, `/account`, `/export` | Source typography, panels, forms, data tables |

Use only values, records, fields, and actions already supplied by the CRM. Do not copy prototype customers, branch comparisons, revenue, conversion, SLA, charts, request-manager fields, or any other source demo data into production UI. There is one real branch: Almaty. No branch selector or network aggregates.
