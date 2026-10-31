# CRM shell specification

## Reference and appearance

- Source: `dashboard-aminpanek/src/App.vue` shell and `src/styles.css` selectors `.sidebar`, `.topbar`, `.main-area`, `.dashboard-content`, `.nav-item`; the live reference screenshot is available at `http://localhost:5173/`.
- Desktop source measurements in CSS: sidebar fixed width 254 px, page topbar height 76 px, topbar horizontal padding 38 px, page content max-width 1440 px, page content top/horizontal padding 41/42 px, sidebar link height 42 px, sidebar padding 27 px 16 px 18 px.
- Fonts: DM Sans for body and Manrope for headings. Canvas `#FAF8F6`, white surfaces, text `#2A1810`, muted `#7F726B`, original source action orange `#FF7A1A`. For this CRM, adapt the action/selected-nav accent to the agreed purple `#3B1E78`; preserve warm light surfaces and source spacing/typography.
- Source uses 12 px navigation text, 10 px uppercase section labels with 0.13em tracking, rounded nav item radius 12 px, 1 px neutral borders, and 11 px small topbar text.
- Sidebar is white in the inspected version; source decoration is soft, low-opacity circles, with the profile block separated by a thin line.

## Structure and content

- Brand block; primary and management nav groups; signed-in staff identity at bottom.
- Topbar: workspace/page location, search where the target route already supports it, authenticated staff/profile and logout.
- CRM routes and authorization remain as in the Next app. Use one Almaty branch and no branch selector.
- Do not add nonfunctional search/profile affordances or copy fake source identity/avatar data.

## Interaction model

- Navigation is link/click driven; current path selects one item.
- Mobile navigation is toggle/click driven with a dismissible overlay and keyboard operation.
- Hover is subtle color change; transition is 0.2 s ease in source.
- No scroll-driven state or time-based content in the shell.

## Responsive behavior

- Source switches to a compact menu/sidebar at 820 px and below. Target should maintain that collapse behavior and avoid horizontal scrolling.
- Main cards stack on narrow screens. Keep the desktop width, white sidebar, 76 px topbar and spacing above.

## Assets

- Source logo is a four-tile CSS mark. Use the existing CRM mark or reproduce the source mark in its existing element.
- No avatar/profile artwork from the source prototype; use signed-in CRM initials.
