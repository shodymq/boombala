# CRM overview specification

## Reference and appearance

- Source: `dashboard-aminpanek/src/App.vue` overview around `.page-heading`, `.metrics-grid`, `.metric-card`, `.content-grid`; CSS in `src/styles.css`.
- Desktop: greeting/title row at top; 4 equal KPI cards in one row (12 px radius, white surface, thin warm-gray border); main dashboard cards use a 2-column grid. The browser reference at 1280 px confirms the same hierarchy.
- Typography: Manrope heading, DM Sans body; page title 800 weight, clamp 27–42 px, line-height 1.12, letter-spacing -0.04em. Body description 13 px. Uppercase section labels 10 px with 0.09em letter spacing.
- Source token baseline is warm/light. Use the agreed purple `#3B1E78` for primary actions, selected/active elements, and chart series, with warm off-white canvas and white cards. Avoid changing semantic status colors.
- Greeting uses the actual source illustration `figma-snowui-illustration-006.svg`, already available in CRM at `/illustrations/snowui-greeting.svg`.

## Target structure and content

- Keep the existing CRM overview server rendering, authorization, database queries, and truthful one-branch data.
- Reuse the source hierarchy for greeting/actions, KPI cards, and dashboard panels. KPI values must be sourced from current CRM counts only: new leads, in-progress leads, bookings/capacity, attendance values when permission/data exist.
- Keep actual catalog package prices, room/slot data, attendance today, notification outbox, database/schema status, and permission list. Use these in source-like cards/panels.
- No demo customers, sample metrics, financial data, branch comparisons, fake growth percentages, or unsupported chart history.

## Interaction model

- KPI cards and actions are ordinary links to existing CRM routes.
- Source KPI cards have decorative sparklines/rings, but the target must not imply a trend without real time-series data. Prefer a simple accent/icon detail.
- Existing source period tabs are demo-only and must not be copied.

## Responsive behavior and assets

- Source overview uses 4 KPI columns at wide viewport and stacks its content panels as viewport narrows. Target may show its existing 3–4 real KPIs in the same grid and collapse to 2 then 1 columns.
- Use only the greeting illustration asset from the source; use CRM data for all displayed values.
