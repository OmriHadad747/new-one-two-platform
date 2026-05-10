# Supported Apps Catalog — Proposed Additions

Candidate apps to extend `SUPPORTED_APPS_CATALOG.md`. Every entry is at or
below the complexity ceiling of #14 (Back In Stock Notify Me): roughly 1
storefront widget, 1–2 webhooks, 1 admin UI page, optional email service.

Format mirrors the existing catalog, plus one new field — **Storefront
shape** — to make the architectural pattern explicit so the storefront
agent's example library can be planned against actual coverage.

---

## Category A — Storefront + Backend (no admin UI)
*Add to the existing Category A.*

### 24. Lookbook / Shop-the-Look Hotspots
- **Similar app:** Lookbook Shop by Gallery Ace, EM Lookbook Gallery, Spot Layer Image Hotspots
- **Flow:** Merchant places a shoppable lookbook block on a landing page or homepage. Customers see a styled photo with small numbered dots; clicking a dot opens a tooltip card showing the tagged product (image, title, price, "Add to Cart"). Backend stores hotspot coordinates per image plus product references. Admin UI is an image-upload + click-to-tag editor.
- **Services:** `ctx.db`, `ctx.services.files` (image upload)
- **Shopify infra:** Storefront widget (block, can fill a page section); Admin API (product search for tagging)
- **Storefront shape:** stateless display + tooltip overlay
- **Why we want it:** First entry to use `ctx.services.files` for image upload plus a coordinate-based tagging admin editor.

### 25. Estimated Delivery Date on PDP
- **Similar app:** Estimator EDD/ETA, NS Estimated Delivery Date, Synctrack Estimated Shipping Date
- **Flow:** Below the Add-to-Cart button, a small box renders "Order in 2h 13m for delivery between Tue May 12 - Thu May 14". Includes a live ticking countdown to the daily cut-off; the date range respects merchant-configured weekends/holidays/processing-days. Admin UI sets cut-off time, weekends/holidays, per-collection overrides.
- **Services:** `ctx.db`
- **Shopify infra:** Storefront widget on PDP; Admin UI; Admin API to read collections
- **Storefront shape:** live-tick / polling, stateless display + variant context
- **Why we want it:** Live-tick pattern in a purely informational form, distinct from a flash-sale countdown.

---

## Category B — Storefront + Backend + Admin UI
*Add to the existing Category B.*

### 26. FAQ Page Builder
- **Similar app:** HelpCenter by Shark Byte, StoreFAQ, HelpHub FAQ Page
- **Flow:** Customer visits a dedicated `/pages/faq` route and sees a multi-section help center: search box, category sidebar (Shipping, Returns, Sizing), expand/collapse Q&A accordions, optional contact form at the bottom. Backend serves the FAQ tree and persists contact-form submissions to email merchant. Admin UI lets the merchant create/edit/reorder categories and questions and view incoming contact-form messages.
- **Services:** `ctx.db`, `ctx.services.email`
- **Shopify infra:** Full-page widget; Admin UI
- **Storefront shape:** **page-template widget** (NEW SHAPE)
- **Why we want it:** First true full-page builder in the catalog — exercises sub-routing, search/filter, and a category+item tree CRUD pattern not covered by any of the existing 16 widget apps.

### 27. Store Locator Page
- **Similar app:** Stockist Store Locator, SC Store Locator & Google Maps, Storemapper
- **Flow:** Customer visits `/pages/store-locator`, types a city or ZIP into a search field, and sees a paginated list of physical stores plus a Google Map with pins. Clicking a pin or list item highlights the store and shows hours, phone, and a "Get directions" link. Backend serves the full store list (lat/lng, address, hours) and optionally geocodes searches via `ctx.http`. Admin UI allows bulk-CSV import + per-row edits.
- **Services:** `ctx.db`, `ctx.http` (geocoding / map tiles), `ctx.services.files` (CSV import)
- **Shopify infra:** Full-page widget; Admin UI
- **Storefront shape:** **page-template widget** (NEW SHAPE)
- **Why we want it:** Geo-search / map-driven full page with a CSV-import admin flow — different data shape than FAQ tree, exercises `ctx.http` for an external map API.

### 28. Size Chart / Size Guide
- **Similar app:** Kiwi Size Chart & Recommender, MP Size Chart & Size Guide, BF Size Charts
- **Flow:** A "Size Guide" link appears on PDP next to the variant selector; clicking opens a modal with the merchant-defined size table (cm/inch toggle), product-category-specific (e.g. "Tops" vs "Bottoms"). Backend looks up which chart applies to the current product (by collection or product tag). Admin UI lets merchant author multiple charts and assign each to one or more collections/tags.
- **Services:** `ctx.db`
- **Shopify infra:** Storefront widget on PDP; Admin UI; Admin API to read collections/tags
- **Storefront shape:** modal overlay, stateless display + variant context
- **Why we want it:** Adds chart-to-product assignment logic (unit toggle + collection-scoped lookup).

### 29. Product Comparison Table
- **Similar app:** Pretty Comparison Tables, Equate Product Compare, Bear Specs & Compare
- **Flow:** Customer browses a collection page and clicks a "Compare" checkbox on up to 4 product cards; a floating "Compare (3)" tray appears at the bottom, and clicking it opens a full-screen overlay showing the chosen products side-by-side across spec rows (price, material, weight, ratings) with differences highlighted. Backend has no per-customer state — selection lives in localStorage; spec data is fetched by product ID. Admin UI defines spec rows and per-product values.
- **Services:** `ctx.db`
- **Shopify infra:** Storefront widget injected on collection + comparison overlay; Admin UI; Admin API to list products
- **Storefront shape:** stateless display + localStorage source, modal overlay
- **Why we want it:** Multi-product selection with localStorage persistence and per-product attribute config — different data flow than any of the existing 16.

### 30. Quick View Modal
- **Similar app:** qikify Quick View Popups, Coral Quick View, Smartviewer Quick View
- **Flow:** On collection/search/home pages, a "Quick View" button appears on hover over each product card; clicking opens a modal pre-loaded with the product's images, price, variant selector, and Add-to-Cart, without leaving the listing page. Backend exposes a lightweight product-detail endpoint; Add-to-Cart uses Shopify's `/cart/add` directly. Admin UI is a single page for toggling on/off and choosing button placement.
- **Services:** `ctx.db` (analytics counter, optional)
- **Shopify infra:** Storefront widget injected into collection grid; Admin UI; Admin API for product details
- **Storefront shape:** **collection-grid DOM injection** (NEW SHAPE), modal overlay, stateless display + variant context
- **Why we want it:** First widget that injects buttons into existing product cards on collection pages — architectural pattern distinct from "render in container."

### 31. Volume Discount Table on PDP
- **Similar app:** Hulk Volume Discount, Dealeasy Volume Discounts, P: Quantity Breaks
- **Flow:** On PDP, a tiered-pricing table renders below the price ("Buy 2: save 10% / Buy 5: save 20%"); when the customer changes the quantity input, the table highlights the active tier and the displayed price updates live. Backend stores tiers per product/collection; the actual discount applies at cart level via Shopify discount codes. Admin UI creates tier sets and assigns them to products/collections.
- **Services:** `ctx.db`
- **Shopify infra:** Storefront widget on PDP; Admin UI; Admin API to manage discount codes
- **Storefront shape:** stateless display + variant context, mutate existing page DOM (price element)
- **Why we want it:** Live-quantity-driven UI updates plus DOM mutation of the existing price element.

### 32. Pre-Order Button (Replace Add-to-Cart)
- **Similar app:** PreOrder Now WOD, Amai PreOrder Manager, Timesact Preorder
- **Flow:** When a product variant is out-of-stock or marked "coming soon," the storefront swaps the standard Add-to-Cart for a "Pre-Order" button with merchant-customised label and an optional ship-by date below it; clicking still adds to cart with a line-item property tagging it as preorder. Admin UI flags products as preorder-enabled; an `orders/create` webhook tags incoming orders.
- **Services:** `ctx.db`
- **Shopify infra:** Storefront widget on PDP; `orders/create` webhook; Admin UI; Admin API to read inventory and tag orders
- **Storefront shape:** mutate existing page DOM, stateless display + variant context
- **Why we want it:** First catalog entry that *replaces* a native theme element rather than adding a new one.

### 33. Newsletter Popup with Discount Code
- **Similar app:** POWR Popup, Coupon Pop by ST, EcomSend, Claspo
- **Flow:** A few seconds after page load (or on exit-intent), a centered overlay popup offers a discount code in exchange for an email; on submit the popup confirms with the code (copy-to-clipboard) and an email is sent. Backend persists subscribers, dedupes on email, and creates a unique Shopify discount code per signup via Admin API. Admin UI lists subscribers, shows conversion stats (impressions/signups/redemptions), edits copy/discount/triggers.
- **Services:** `ctx.db`, `ctx.services.email`
- **Shopify infra:** Storefront overlay (site-wide); Admin UI; Admin API to create discount codes
- **Storefront shape:** modal overlay, form-persist no state-check
- **Why we want it:** Combines exit-intent triggering, Admin-API discount creation, and a stats dashboard.

### 34. Cart Drawer with Upsells & Free-Shipping Bar
- **Similar app:** Upcart, iCart Cart Drawer, Amp Slide Cart, Kaching CartDrawer
- **Flow:** When a customer clicks the cart icon, a slide-out drawer replaces the default cart with line items, a free-shipping progress bar at the top, and 1–3 recommended upsell products at the bottom; customers update qty or add upsells without leaving the page. Backend serves upsell rules (per-product or collection-based) and the free-shipping threshold. Admin UI configures threshold + upsell rules + drawer copy.
- **Services:** `ctx.db`
- **Shopify infra:** Storefront widget (cart drawer overrides theme cart); Admin UI; Admin API for product reads
- **Storefront shape:** cart-aware widget, modal overlay
- **Why we want it:** First cart-aware widget that actively reads/mutates the live cart and reacts to `/cart.js` changes — fundamentally different lifecycle than the existing 16.

---

## REJECTED — exceed Back-in-Stock complexity ceiling

| App type | Why rejected |
|---|---|
| Loox / Judge.me Product Reviews | Review-request email automation + photo/video upload pipeline + moderation queue + star-rating aggregation across surfaces — multi-feature scope above ceiling. |
| Yotpo Loyalty / Smile.io | Point earning rules, redemption tiers, referral codes, VIP segments, multi-channel email/SMS engines. |
| Klaviyo-style email marketing suites | Full email segmentation + automation flows + template editor. |
| BOGOS / MaxBundle full bundle builders | Mix-and-match bundles with per-bundle inventory and discount-function authoring. Tiered tables (#31) stay within bounds. |
| Subscription / Recurring Orders | Shopify Subscriptions API + billing complexity. |
| Multi-step gamified popups (full Claspo) | Conditional logic engine in admin. The simpler discount popup (#33) stays within bounds. |
| Live chat / chatbot | Real-time messaging plus agent UI. |
| Recipe Kit / shoppable recipe blog | Content-management workflows + ingredient-to-product linking + nutritional calculator. |

---

## Sources

Apps verified on the Shopify App Store (May 2026):

- FAQ: HelpCenter, StoreFAQ, HelpHub FAQ Page
- Store locator: Stockist, SC Store Locator, Storemapper
- Size charts: Kiwi Sizing, MP/Avada Size Chart, BF Size Charts
- Comparison: Pretty Comparison Tables, Equate Product Compare, Bear Specs & Compare
- Quick view: qikify Quick View, Coral Quick View, Smartviewer
- Volume discount: Hulk Volume Discount, Dealeasy, P: Quantity Breaks
- Pre-order: PreOrder Now WOD, Amai PreOrder, Timesact
- Lookbook: Lookbook Shop by Gallery Ace, EM Lookbook, Spot Layer Hotspots
- Newsletter popup: POWR Popup, Coupon Pop, EcomSend, Claspo
- Cart drawer: Upcart, iCart, Amp Slide Cart, Kaching
- Estimated delivery: Estimator EDD/ETA, NS Estimated Delivery, Synctrack
