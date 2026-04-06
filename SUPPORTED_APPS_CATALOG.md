# Supported Apps Catalog

Each app is categorised by its architectural shape. Services column uses the current surface:
- **Platform:** `ctx.shopify`, `ctx.db`, `ctx.storefront`, `ctx.http`, `ctx.shop`
- **ctx.services:** `email` (stub→Resend), `sms` (stub→Twilio), `files` (stub→GCS)
- **JS lib:** handler declares `npmPackages`, uses `require()`

---

## Category A — Storefront + Backend
*Widget on the storefront. Backend stores config or processes webhook events. No Admin UI.*

### 1. Announcement Bar
- **Similar app:** Hextom Free Shipping Bar, Quick Announcement Bar
- **Flow:** Widget fetches announcement text, link, and styling from the handler on page load and renders a top-of-page bar. Handler stores merchant config in DB.
- **Services:** `ctx.db`
- **Shopify infra:** Storefront widget

### 2. Trust & Payment Badges
- **Similar app:** Trust Badge Master
- **Flow:** Widget fetches the merchant's configured badge set from the handler and renders it below the Add to Cart button.
- **Services:** `ctx.db`
- **Shopify infra:** Storefront widget

### 3. Cookie Consent Banner
- **Similar app:** GDPR Cookie Compiler
- **Flow:** Widget displays a consent banner on first visit. Consent stored in browser localStorage or a Shopify Customer Metafield. Handler stores banner config.
- **Services:** `ctx.db`
- **Shopify infra:** Storefront widget, Customer Privacy API

### 4. Flash Sale Countdown Timer
- **Similar app:** Hurrify Countdown Timer
- **Flow:** Merchant configures an end date and target products via platform dashboard. Widget fetches the deadline from the handler and renders a live countdown.
- **Services:** `ctx.db`
- **Shopify infra:** Storefront widget

### 5. Free Shipping Progress Bar
- **Similar app:** Essential Free Shipping Bar
- **Flow:** Widget listens to cart updates via the Storefront Cart API. It compares the cart total against a threshold from the handler and renders a progress bar.
- **Services:** `ctx.db`
- **Shopify infra:** Storefront widget, Storefront Cart API (AJAX)

### 6. Recently Viewed Products
- **Similar app:** Vitals All-in-One Marketing
- **Flow:** Widget tracks product page views in localStorage. Fetches product details from the Storefront API for stored IDs and renders a carousel.
- **Services:** `ctx.db` (widget config/styling)
- **Shopify infra:** Storefront widget, Storefront API

### 7. Social Proof Sales Pop
- **Similar app:** Sales Pop up - Conversion Pro
- **Flow:** Handler listens to `orders/create` webhooks and stores anonymised purchase data (city, product). Widget polls the handler and shows toast notifications to live visitors.
- **Services:** `ctx.db`
- **Shopify infra:** Storefront widget, `orders/create` webhook

### 8. Low Stock Urgency Badge
- **Similar app:** Urgency Bear
- **Flow:** Handler listens to `inventory_levels/update` and caches low-stock items in DB. Widget fetches the stock level and shows "Only X left in stock!" badge.
- **Services:** `ctx.db`
- **Shopify infra:** Storefront widget, `inventory_levels/update` webhook

### 9. Wishlists
- **Similar app:** Wishlist Plus
- **Flow:** Customer clicks a heart icon. Widget sends customer ID + product ID to the handler which saves the relation to DB. Widget re-fetches to show saved state.
- **Services:** `ctx.db`
- **Shopify infra:** Storefront widget

### 10. Product Q&A Widget
- **Similar app:** Hulk Product Q&A
- **Flow:** Widget shows existing questions and answers fetched from the handler. Customers submit new questions. Handler stores them and notifies the merchant via email.
- **Services:** `ctx.db`, `ctx.services.email`
- **Shopify infra:** Storefront widget

### 11. Age Verification Gate
- **Similar app:** Age Verification by Minimum
- **Flow:** Handler provides age-gate config (threshold, styling). Widget blocks page content and prompts age confirmation. Result stored in localStorage / session.
- **Services:** `ctx.db`
- **Shopify infra:** Storefront widget

### 12. Currency Switcher
- **Similar app:** BEST Currency Converter
- **Flow:** Handler fetches current exchange rates via `ctx.http` from a free rates API and caches them in DB (refreshed by cron). Widget reads the visitor's locale, calls the handler, and re-renders prices.
- **Services:** `ctx.db`, `ctx.http`
- **Shopify infra:** Storefront widget, cron (daily rate refresh)

---

## Category B — Storefront + Backend + Admin UI
*Widget on the storefront for customer interaction + merchant dashboard in Shopify Admin.*

### 13. Price Drop Alert
- **Similar app:** Price Drop Alert
- **Flow:** Customers subscribe to price drops for a specific variant via the widget. Handler stores subscriptions. On `products/update` webhook, if price decreased, handler queries DB and emails subscribers. Admin UI shows active subscriptions.
- **Services:** `ctx.db`, `ctx.services.email`
- **Shopify infra:** Storefront widget, `products/update` webhook, Admin UI

### 14. Back In Stock Notify Me
- **Similar app:** Back in Stock: Customer Alerts
- **Flow:** Customers subscribe to out-of-stock variants. On `inventory_levels/update` webhook, when stock becomes positive, handler emails all subscribers for that variant. Admin UI shows subscribers, conversion rates, manual trigger.
- **Services:** `ctx.db`, `ctx.services.email`
- **Shopify infra:** Storefront widget, `inventory_levels/update` webhook, Admin UI

### 15. Spin-to-Win Discount Wheel
- **Similar app:** Wheelio, Spin-a-Sale
- **Flow:** Widget renders a spin wheel; customer enters email to spin. Handler generates a unique discount code via the Shopify Admin API and emails it. Admin UI shows spin results and code redemption stats.
- **Services:** `ctx.db`, `ctx.services.email`
- **Shopify infra:** Storefront widget, Admin API (`discountCodeCreate`), Admin UI

### 16. Product Waitlist
- **Similar app:** Notify Me! Restock Alert
- **Flow:** Widget shows a "Join Waitlist" form on sold-out products. Handler stores email + product. When merchant restocks (detected via `inventory_levels/update`), handler emails all waitlisted customers. Admin UI lists waitlisted products.
- **Services:** `ctx.db`, `ctx.services.email`
- **Shopify infra:** Storefront widget, `inventory_levels/update` webhook, Admin UI

---

## Category C — Backend Only
*No storefront widget, no custom Admin UI. Fully automatic — webhook or cron triggered.*

### 17. Order Thank You Email
- **Similar app:** Klaviyo / Omnisend (transactional)
- **Flow:** On `orders/create`, extracts customer email and order details and sends a personalised thank-you via `ctx.services.email`.
- **Services:** `ctx.db`, `ctx.services.email`
- **Shopify infra:** `orders/create` webhook

### 18. Abandoned Cart Recovery Email
- **Similar app:** Privy
- **Flow:** On `checkouts/create`, stores checkout timestamp. Cron polls for checkouts older than 1 hour with no matching order and sends a recovery email.
- **Services:** `ctx.db`, `ctx.services.email`
- **Shopify infra:** `checkouts/create` webhook, cron

### 19. Post-Purchase Review Request
- **Similar app:** Loox, Judge.me
- **Flow:** On `orders/fulfilled`, stores a scheduled task. Daily cron sends review request emails for orders that fulfilled X days ago.
- **Services:** `ctx.db`, `ctx.services.email`
- **Shopify infra:** `orders/fulfilled` webhook, cron

### 20. Abandoned Cart Recovery SMS
- **Similar app:** SMSBump
- **Flow:** Same flow as email recovery but sends an SMS to the customer's phone number.
- **Services:** `ctx.db`, `ctx.services.sms`
- **Shopify infra:** `checkouts/update` webhook, cron

### 21. Low Inventory Email Digest
- **Similar app:** Low Stock Alert
- **Flow:** Daily cron queries Admin GraphQL for inventory levels across all locations. Compiles variants below a configured threshold and emails a digest to the merchant.
- **Services:** `ctx.db`, `ctx.services.email`
- **Shopify infra:** cron, Admin API (`inventoryLevels`)

### 22. Auto Order Tagger (Automatic)
- **Similar app:** Auto Tags
- **Flow:** On `orders/create`, evaluates rule conditions (order value, product type, customer tag, country) and applies matching tags via `tagsAdd` GraphQL mutation. Rules stored in DB.
- **Services:** `ctx.db`
- **Shopify infra:** `orders/create` webhook, Admin API (`tagsAdd`)

### 23. Customer Win-Back Email
- **Similar app:** Klaviyo win-back flows
- **Flow:** Daily cron identifies customers whose last order was 60+ days ago and who haven't been contacted recently. Sends a personalised win-back email with a discount code generated via the Admin API.
- **Services:** `ctx.db`, `ctx.services.email`
- **Shopify infra:** cron, Admin API (`discountCodeCreate`, orders query)

### 24. Image Size Optimizer
- **Similar app:** Crush.pics
- **Flow:** On `products/update`, detects new product images. Downloads each image, resizes and compresses it with `sharp`, then re-uploads the optimised version via the Shopify Admin API (`productCreateMedia` / `stagedUploadsCreate`).
- **Services:** `ctx.db`, `ctx.http`
- **JS libs:** `sharp`
- **Shopify infra:** `products/update` webhook, Admin API (media upload)

### 25. Product Feed Generator (Google Shopping)
- **Similar app:** Simprosys Google Shopping Feed
- **Flow:** Daily cron fetches all products via Admin API, formats them as a Google Merchant Center XML feed using `fast-xml-parser`, and stores the result in DB. A widget endpoint serves the feed at a public URL.
- **Services:** `ctx.db`
- **JS libs:** `fast-xml-parser`
- **Shopify infra:** cron, Admin API (products), storefront widget endpoint (serves XML)

### 26. Packing Slip PDF Generator (Automatic)
- **Similar app:** Order Printer Pro (automated variant)
- **Flow:** On `orders/create`, generates a packing slip PDF using `pdfkit` from a merchant-configured HTML template and stores the PDF URL in the order metafield for fulfilment staff.
- **Services:** `ctx.db`, `ctx.services.files`
- **JS libs:** `pdfkit`
- **Shopify infra:** `orders/create` webhook, Admin API (metafield write)

---

## Category D — Backend + Admin UI
*No storefront widget. Merchant dashboard or control panel embedded in Shopify Admin.*

### 27. Bulk Order Tagger (Manual)
- **Similar app:** Auto Tags (manual mode)
- **Flow:** Admin UI lets merchant define rules and click "Run Now". Handler evaluates rules against recent orders and applies tags via `tagsAdd`.
- **Services:** `ctx.db`
- **Shopify infra:** Admin UI, Admin API (`tagsAdd`)

### 28. Custom Order CSV Exporter
- **Similar app:** EZ Exporter
- **Flow:** Admin UI provides date range and field selection. Handler queries orders via Admin API, formats with `csv-stringify`, returns CSV string directly to the admin UI for browser download.
- **Services:** `ctx.db`
- **JS libs:** `csv-stringify`
- **Shopify infra:** Admin UI, Admin API (orders query)

### 29. Custom Packing Slip Printer
- **Similar app:** Order Printer Pro
- **Flow:** Merchant selects orders in Admin UI and clicks Print. Handler queries order data, injects it into an HTML template with `handlebars`, converts to PDF with `pdfkit`, and returns the buffer to the frontend.
- **Services:** `ctx.db`
- **JS libs:** `pdfkit`, `handlebars`
- **Shopify infra:** Admin UI, Admin API (orders query)

### 30. Discount Code Bulk Generator
- **Similar app:** Bulk Discount Code Bot
- **Flow:** Admin UI lets merchant configure prefix, count, and percentage. Handler generates unique codes via the Admin API (`discountCodeBulkAdd`) and offers a CSV download of the generated codes.
- **Services:** `ctx.db`
- **JS libs:** `csv-stringify`, `uuid`
- **Shopify infra:** Admin UI, Admin API (`discountCodeBulkAdd`)

### 31. Order Analytics Dashboard
- **Similar app:** Better Reports
- **Flow:** Admin UI shows revenue, AOV, top products, repeat purchase rate. Handler runs aggregation queries against DB (orders cached from webhooks) and returns chart-ready JSON.
- **Services:** `ctx.db`
- **Shopify infra:** Admin UI, `orders/create` + `orders/updated` webhooks (to populate local cache)

### 32. Customer Segment Tagger
- **Similar app:** Seguno, Klaviyo segments
- **Flow:** Admin UI lets merchant define customer segments (spent > $X, ordered Y+ times, from country Z). Handler queries Admin GraphQL, applies customer tags in bulk. Shows progress and results in Admin UI.
- **Services:** `ctx.db`
- **Shopify infra:** Admin UI, Admin API (`tagsAdd`, customers query)

### 33. Inventory Reorder Assistant
- **Similar app:** Stocky
- **Flow:** Admin UI shows products projected to run out within X days based on sales velocity. Handler runs a daily cron to compute velocity and threshold from order history + inventory levels. Merchant can trigger a reorder email to their supplier from the UI.
- **Services:** `ctx.db`, `ctx.services.email`
- **Shopify infra:** Admin UI, cron, Admin API (orders + inventory)

### 34. Returns & Refund Manager
- **Similar app:** Loop Returns (simplified)
- **Flow:** Admin UI lists open return requests submitted via a storefront widget (Category B variant possible). Handler processes refunds via Admin API (`refundCreate`), updates order tags, and notifies the customer by email.
- **Services:** `ctx.db`, `ctx.services.email`
- **Shopify infra:** Admin UI, Admin API (`refundCreate`, `tagsAdd`)
