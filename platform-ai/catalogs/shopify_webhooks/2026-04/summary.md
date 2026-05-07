## Shopify webhook topics — version 2026-04

_(catalog pinned to gadget-inc/shopify-webhook-schemas@ac21e6a)_

Each entry shows the webhook's topic string, what triggers it, and the fields its payload actually delivers. The trigger's HLD `signalFields` should map onto these fields; if a needed value isn't here, the LLD must derive it from a Shopify lookup.

### app

- **app/scopes_update** — Occurs whenever the access scopes of any installation are modified. Allows apps to keep track of the granted access scopes of their installations.
  fields: current (array<string>), id (integer), previous (array<string>), shop_id (string:uri), updated_at (string:date-time)
- **app/uninstalled** — Occurs whenever a shop has uninstalled the app.
  fields: address1 (string), address2 (string|null), auto_configure_tax_inclusivity (boolean|null), checkout_api_supported (boolean), city (string), country (string), country_code (string), country_name (string), county_taxes (boolean|null), created_at (string:date-time|null), currency (string), customer_email (string:email), domain (string:hostname|null), eligible_for_payments (boolean), email (string:email), enabled_presentment_currencies (array<string>), finances (boolean), google_apps_domain (string:hostname|null), google_apps_login_enabled (boolean|null), has_discounts (boolean), has_gift_cards (boolean), has_storefront (boolean), iana_timezone (string|null), id (integer), latitude (number|null), longitude (number|null), marketing_sms_consent_enabled_at_checkout (boolean), money_format (string), money_in_emails_format (string), money_with_currency_format (string), money_with_currency_in_emails_format (string), multi_location_enabled (boolean), myshopify_domain (string:hostname|null), name (string), password_enabled (boolean|null), phone (string), plan_display_name (string), plan_name (string), pre_launch_enabled (boolean), primary_locale (string), primary_location_id (integer), province (string), province_code (string), requires_extra_payments_agreement (boolean), setup_required (boolean), shop_owner (string), source (string|null), tax_shipping (boolean|null), taxes_included (boolean|null), timezone (string), transactional_sms_disabled (boolean), updated_at (string:date-time|null), weight_unit (string), zip (string)

### app_purchases_one_time

- **app_purchases_one_time/update** — Occurs whenever a one-time app charge is updated.
  fields: app_purchase_one_time (object)

### app_subscriptions

- **app_subscriptions/approaching_capped_amount** — Occurs when the balance used on an app subscription crosses 90% of the capped amount.
  fields: app_subscription (object)
- **app_subscriptions/update** — Occurs whenever an app subscription is updated.
  fields: app_subscription (object)

### audit_events

- **audit_events/admin_api_activity** — Triggers for each auditable Admin API request. This topic is limited to one active subscription per Plus store and requires the use of Google Cloud Pub/Sub or AWS EventBridge.
  fields: events (array<object>)

### bulk_operations

- **bulk_operations/finish** — Notifies when a Bulk Operation finishes.
  fields: admin_graphql_api_id (string:uri), completed_at (string:date-time), created_at (string:date-time), error_code (string|null), status (string), type (string)

### carts

- **carts/create** — Occurs when a cart is created in the online store. Other types of carts aren't supported. For example, the webhook doesn't support carts that are created in a custom storefront.
  fields: created_at (string:date-time), id (string), line_items (array<object>), note (string|null), token (string), updated_at (string:date-time)
- **carts/update** — Occurs when a cart is updated in the online store. Other types of carts aren't supported. For example, the webhook doesn't support carts that are updated in a custom storefront.
  fields: created_at (string:date-time), id (string), line_items (array<object>), note (string|null), token (string), updated_at (string:date-time)

### channels

- **channels/delete** — Occurs whenever a channel is deleted.
  fields: id (string)

### checkouts

- **checkouts/create** — Occurs whenever a checkout is created.
  fields: abandoned_checkout_url (string:uri), billing_address (object), buyer_accepts_marketing (boolean), buyer_accepts_sms_marketing (boolean), cart_token (string|null), closed_at (string:date-time|null), completed_at (string:date-time|null), created_at (string), currency (string), customer (object), customer_locale (string|null), device_id (string|null), discount_codes (array<object>), email (string|null), gateway (string|null), landing_site (string|null), line_items (array<object>), location_id (integer|null), name (string), note (string|null), note_attributes (array<object>), phone (string|null), presentment_currency (string), referring_site (string|null), reservation_token (string|null), shipping_address (object), shipping_lines (array<object>), sms_marketing_phone (string|null), source (string|null), source_identifier (string|null), source_name (string), source_url (string:uri|null), subtotal_price (string), tax_lines (array<object>), taxes_included (boolean), token (string), total_discounts (string), total_duties (unknown), total_line_items_price (string), total_price (string), total_tax (string), total_weight (integer), updated_at (string), user_id (integer|null)
- **checkouts/delete** — Occurs whenever a checkout is deleted.
  fields: buyer_accepts_sms_marketing (boolean), cart_token (string|null), id (integer), presentment_currency (string), reservation_token (string|null), sms_marketing_phone (string|null), subtotal_price (string), total_discounts (string), total_duties (unknown), total_line_items_price (string), total_price (string), total_tax (string)
- **checkouts/update** — Occurs whenever a checkout is updated.
  fields: abandoned_checkout_url (string:uri), billing_address (object), buyer_accepts_marketing (boolean), buyer_accepts_sms_marketing (boolean), cart_token (string|null), closed_at (string:date-time|null), completed_at (string:date-time|null), created_at (string), currency (string), customer (object), customer_locale (string|null), device_id (string|null), discount_codes (array<object>), email (string|null), gateway (string|null), landing_site (string|null), line_items (array<object>), location_id (integer|null), name (string), note (string|null), note_attributes (array<object>), phone (string|null), presentment_currency (string), referring_site (string|null), reservation_token (string|null), shipping_address (object), shipping_lines (array<object>), sms_marketing_phone (string|null), source (string|null), source_identifier (string|null), source_name (string), source_url (string:uri|null), subtotal_price (string), tax_lines (array<object>), taxes_included (boolean), token (string), total_discounts (string), total_duties (unknown), total_line_items_price (string), total_price (string), total_tax (string), total_weight (integer), updated_at (string), user_id (integer|null)

### collection_listings

- **collection_listings/add** — Occurs whenever a collection listing is added.
  fields: collection_listing (object)
- **collection_listings/remove** — Occurs whenever a collection listing is removed.
  fields: collection_listing (object)
- **collection_listings/update** — Occurs whenever a collection listing is updated.
  fields: collection_listing (object)

### collection_publications

- **collection_publications/create** — Occurs whenever a collection publication listing is created.
  fields: collection_id (integer), created_at (string:date-time|null), id (null), publication_id (null), published (boolean), published_at (string:date-time), updated_at (string:date-time|null)
- **collection_publications/delete** — Occurs whenever a collection publication listing is deleted.
  fields: id (null)
- **collection_publications/update** — Occurs whenever a collection publication listing is updated.
  fields: collection_id (integer), created_at (string:date-time|null), id (null), publication_id (null), published (boolean), published_at (string:date-time), updated_at (string:date-time|null)

### collections

- **collections/create** — Occurs whenever a collection is created.
  fields: admin_graphql_api_id (string:uri), body_html (string), disjunctive (boolean|null), handle (string), id (integer), image (object|null), published_at (string:date-time), published_scope (string), rules (array<object>|null), sort_order (string|null), template_suffix (string|null), title (string), updated_at (string:date-time)
- **collections/delete** — Occurs whenever a collection is deleted.
  fields: admin_graphql_api_id (string:uri), id (integer), published_scope (string)
- **collections/update** — Occurs whenever a collection is updated, including when a product is manually added or removed from the collection or when the collection rules change. Occurs once if multiple products are manually added or removed from a collection at the same time. Not fired when attribute changes affect whether a product matches a collection's rules.
  fields: admin_graphql_api_id (string:uri), body_html (string), disjunctive (boolean|null), handle (string), id (integer), image (object|null), published_at (string:date-time), published_scope (string), rules (array<object>|null), sort_order (string|null), template_suffix (string|null), title (string), updated_at (string:date-time)

### companies

- **companies/create** — Occurs whenever a company is created.
  fields: admin_graphql_api_id (string:uri), created_at (string:date-time), customer_since (string:date-time), external_id (string), main_contact_admin_graphql_api_id (string:uri), name (string), note (string), updated_at (string:date-time)
- **companies/delete** — Occurs whenever a company is deleted.
  fields: admin_graphql_api_id (string:uri), created_at (string:date-time), customer_since (string:date-time), external_id (string), main_contact_admin_graphql_api_id (string:uri), name (string), note (string), updated_at (string:date-time)
- **companies/update** — Occurs whenever a company is updated.
  fields: admin_graphql_api_id (string:uri), created_at (string:date-time), customer_since (string:date-time), external_id (string), main_contact_admin_graphql_api_id (string:uri), name (string), note (string), updated_at (string:date-time)

### company_contact_roles

- **company_contact_roles/assign** — Occurs whenever a role is assigned to a contact at a location.
  fields: company_contact (object), company_contact_role (object), company_location (object)
- **company_contact_roles/revoke** — Occurs whenever a role is revoked from a contact at a location.
  fields: company_contact (object), company_contact_role (object), company_location (object)

### company_contacts

- **company_contacts/create** — Occurs whenever a company contact is created.
  fields: admin_graphql_api_id (string:uri), company (object), created_at (string:date-time), customer_admin_graphql_api_id (string:uri), locale (string), title (string), updated_at (string:date-time)
- **company_contacts/delete** — Occurs whenever a company contact is deleted.
  fields: admin_graphql_api_id (string:uri), company (object), created_at (string:date-time), customer_admin_graphql_api_id (string:uri), locale (string), title (string), updated_at (string:date-time)
- **company_contacts/update** — Occurs whenever a company contact is updated.
  fields: admin_graphql_api_id (string:uri), company (object), created_at (string:date-time), customer_admin_graphql_api_id (string:uri), locale (string), title (string), updated_at (string:date-time)

### company_locations

- **company_locations/create** — Occurs whenever a company location is created.
  fields: admin_graphql_api_id (string:uri), billing_address (object), buyer_experience_configuration (object|null), company (object), created_at (string:date-time), external_id (string), locale (string), name (string), note (string), phone (string), shipping_address (object), tax_exemptions (array<string>), tax_registration (object|null), tax_settings (object), updated_at (string:date-time)
- **company_locations/delete** — Occurs whenever a company location is deleted.
  fields: admin_graphql_api_id (string:uri), billing_address (object), buyer_experience_configuration (object|null), company (object), created_at (string:date-time), external_id (string), locale (string), name (string), note (string), phone (string), shipping_address (object), tax_exemptions (array<string>), tax_registration (object|null), tax_settings (object), updated_at (string:date-time)
- **company_locations/update** — Occurs whenever a company location is updated.
  fields: admin_graphql_api_id (string:uri), billing_address (object), buyer_experience_configuration (object|null), company (object), created_at (string:date-time), external_id (string), locale (string), name (string), note (string), phone (string), shipping_address (object), tax_exemptions (array<string>), tax_registration (object|null), tax_settings (object), updated_at (string:date-time)

### customer.joined_segment

- **customer.joined_segment** — Triggers when a customer joins a segment.
  fields: customer_id (string:uri), segment_id (string:uri), shop_id (string:uri)

### customer.left_segment

- **customer.left_segment** — Triggers when a customer leaves a segment.
  fields: customer_id (string:uri), segment_id (string:uri), shop_id (string:uri)

### customer.tags_added

- **customer.tags_added** — Triggers when tags are added to a customer.
  fields: customerId (string:uri), occurredAt (string:date-time), tags (array<string>)

### customer.tags_removed

- **customer.tags_removed** — Triggers when tags are removed from a customer.
  fields: customerId (string:uri), occurredAt (string:date-time), tags (array<string>)

### customer_account_settings

- **customer_account_settings/update** — Triggers when merchants change customer account setting.
  fields: customer_accounts_version (string), login_links_visible_on_storefront_and_checkout (boolean), login_required_at_checkout (boolean), url (string:uri|null)

### customer_groups

- **customer_groups/create** — Occurs whenever a customer saved search is created.
  fields: created_at (string:date-time), id (integer), name (string), query (string), updated_at (string:date-time)
- **customer_groups/delete** — Occurs whenever a customer saved search is deleted.
  fields: id (integer)
- **customer_groups/update** — Occurs whenever a customer saved search is updated.
  fields: created_at (string:date-time), id (integer), name (string), query (string), updated_at (string:date-time)

### customer_payment_methods

- **customer_payment_methods/create** — Occurs whenever a customer payment method is created.
  fields: admin_graphql_api_customer_id (string:uri), admin_graphql_api_id (string:uri), customer_id (integer), instrument_type (string), payment_instrument (object), resource_type (string), token (string)
- **customer_payment_methods/revoke** — Occurs whenever a customer payment method is revoked.
  fields: admin_graphql_api_customer_id (string:uri), admin_graphql_api_id (string:uri), customer_id (integer), instrument_type (string), payment_instrument (object), resource_type (string), token (string)
- **customer_payment_methods/update** — Occurs whenever a customer payment method is updated.
  fields: admin_graphql_api_customer_id (string:uri), admin_graphql_api_id (string:uri), customer_id (integer), instrument_type (string), payment_instrument (object), resource_type (string), token (string)

### customers

- **customers/create** — Occurs whenever a customer is created.
  fields: addresses (array<object>), admin_graphql_api_id (string:uri), created_at (string:date-time), currency (string), default_address (object), email (string:email), first_name (string), id (integer), last_name (string), multipass_identifier (string|null), note (string), phone (string|null), state (string), tax_exempt (boolean), tax_exemptions (array<string>), updated_at (string:date-time), verified_email (boolean)
- **customers/data_request** — Customers can request their data from a store owner. When this happens, Shopify sends a payload on the customers/data_request topic to the apps that are installed on that store.
  fields: customer (object), data_request (object), orders_requested (array<integer>), shop_domain (string), shop_id (integer)
- **customers/delete** — Occurs whenever a customer is deleted.
  fields: admin_graphql_api_id (string:uri), id (integer), tax_exemptions (array<string>)
- **customers/disable** — Occurs whenever a customer account is disabled.
  fields: addresses (array<object>), admin_graphql_api_id (string:uri), created_at (string:date-time), currency (string), default_address (object), email (string:email), first_name (string), id (integer), last_name (string), multipass_identifier (string|null), note (string), phone (string|null), state (string), tax_exempt (boolean), tax_exemptions (array<string>), updated_at (string:date-time), verified_email (boolean)
- **customers/enable** — Occurs whenever a customer account is enabled.
  fields: addresses (array<object>), admin_graphql_api_id (string:uri), created_at (string:date-time), currency (string), default_address (object), email (string:email), first_name (string), id (integer), last_name (string), multipass_identifier (string|null), note (string), phone (string|null), state (string), tax_exempt (boolean), tax_exemptions (array<string>), updated_at (string:date-time), verified_email (boolean)
- **customers/merge** — Triggers when two customers are merged
  fields: admin_graphql_api_customer_deleted_id (string:uri), admin_graphql_api_customer_kept_id (string:uri), admin_graphql_api_job_id (string:uri|null), errors (array<object>), status (string)
- **customers/purchasing_summary** — Occurs when a customer sales history change.
  fields: amountSpent (object), customerId (string:uri), lastOrderId (string:uri), numberOfOrders (integer), occurredAt (string:date-time)
- **customers/redact** — Store owners can request that data is deleted on behalf of a customer. When this happens, Shopify sends a payload on the customers/redact topic to the apps installed on that store.

Customer redaction occurs either at the end of the grace period after the redaction was requested (today + 10 days), OR the customer's last order date plus the chargeback period of 60 days (last order date + 60 days), whichever occurs later.
  fields: customer (object), orders_to_redact (array<integer>), shop_domain (string), shop_id (integer)
- **customers/update** — Occurs whenever a customer is updated.
  fields: addresses (array<object>), admin_graphql_api_id (string:uri), created_at (string:date-time), currency (string), default_address (object), email (string:email), first_name (string), id (integer), last_name (string), multipass_identifier (string|null), note (string), phone (string|null), state (string), tax_exempt (boolean), tax_exemptions (array<string>), updated_at (string:date-time), verified_email (boolean)

### customers_email_marketing_consent

- **customers_email_marketing_consent/update** — Occurs whenever a customer's email marketing consent is updated.
  fields: customer_id (integer), email_address (string:email), email_marketing_consent (object)

### customers_marketing_consent

- **customers_marketing_consent/update** — Occurs whenever a customer's SMS marketing consent is updated.
  fields: id (integer), phone (string|null), sms_marketing_consent (object)

### delivery_promise_settings

- **delivery_promise_settings/update** — Occurs when a promise setting is updated.
  fields: delivery_dates_enabled (boolean), processing_time (string), shop_id (string:uri)

### discounts

- **discounts/create** — Occurs whenever a discount is created.
  fields: admin_graphql_api_id (string:uri), created_at (string:date-time), status (string), title (string), updated_at (string:date-time)
- **discounts/delete** — Occurs whenever a discount is deleted.
  fields: admin_graphql_api_id (string:uri), deleted_at (string:date-time)
- **discounts/redeemcode_added** — Occurs whenever a redeem code is added to a code discount.
  fields: admin_graphql_api_id (string:uri), redeem_code (object), updated_at (string:date-time)
- **discounts/redeemcode_removed** — Occurs whenever a redeem code on a code discount is deleted.
  fields: admin_graphql_api_id (string:uri), redeem_code (object), updated_at (string:date-time)
- **discounts/update** — Occurs whenever a discount is updated.
  fields: admin_graphql_api_id (string:uri), created_at (string:date-time), status (string), title (string), updated_at (string:date-time)

### disputes

- **disputes/create** — Occurs whenever a dispute is created.
  fields: amount (string), currency (string), evidence_due_by (string:date-time), evidence_sent_on (string:date-time|null), finalized_on (string:date-time|null), id (integer), initiated_at (string:date-time), network_reason_code (string), order_id (integer), reason (string), status (string), type (string)
- **disputes/update** — Occurs whenever a dispute is updated.
  fields: amount (string), currency (string), evidence_due_by (string:date-time), evidence_sent_on (string:date-time|null), finalized_on (string:date-time|null), id (integer), initiated_at (string:date-time), network_reason_code (string), order_id (integer), reason (string), status (string), type (string)

### domains

- **domains/create** — Occurs whenever a domain is created.
  fields: host (string), id (integer), localization (object|null), ssl_enabled (boolean)
- **domains/destroy** — Occurs whenever a domain is destroyed.
  fields: host (string), id (integer), localization (object|null), ssl_enabled (boolean)
- **domains/update** — Occurs whenever a domain is updated.
  fields: host (string), id (integer), localization (object|null), ssl_enabled (boolean)

### draft_orders

- **draft_orders/create** — Occurs whenever a draft order is created.
  fields: admin_graphql_api_id (string:uri), allow_discount_codes_in_checkout? (boolean), api_client_id (integer|null), applied_discount (object|null), b2b? (boolean), billing_address (object), completed_at (string:date-time|null), created_at (string:date-time), created_on_api_version_handle (string:date-time|null), currency (string), customer (object), email (string), id (integer), invoice_sent_at (string:date-time|null), invoice_url (string:uri), line_items (array<object>), name (string), note (string|null), note_attributes (array<object>), order_id (unknown), payment_terms (unknown), shipping_address (object), shipping_line (object|null), status (string), subtotal_price (string), tags (string), tax_exempt (boolean), tax_lines (array<object>), taxes_included (boolean), total_price (string), total_tax (string), updated_at (string:date-time)
- **draft_orders/delete** — Occurs whenever a draft order is deleted.
  fields: id (integer)
- **draft_orders/update** — Occurs whenever a draft order is updated.
  fields: admin_graphql_api_id (string:uri), allow_discount_codes_in_checkout? (boolean), api_client_id (integer|null), applied_discount (object|null), b2b? (boolean), billing_address (object), completed_at (string:date-time|null), created_at (string:date-time), created_on_api_version_handle (string:date-time|null), currency (string), customer (object), email (string), id (integer), invoice_sent_at (string:date-time|null), invoice_url (string:uri), line_items (array<object>), name (string), note (string|null), note_attributes (array<object>), order_id (unknown), payment_terms (unknown), shipping_address (object), shipping_line (object|null), status (string), subtotal_price (string), tags (string), tax_exempt (boolean), tax_lines (array<object>), taxes_included (boolean), total_price (string), total_tax (string), updated_at (string:date-time)

### finance_app_staff_member

- **finance_app_staff_member/delete** — Triggers when a staff with access to all or some finance app has been removed.
  fields: (no fields)
- **finance_app_staff_member/grant** — Triggers when a staff is granted access to all or some finance app.
  fields: (no fields)
- **finance_app_staff_member/revoke** — Triggers when a staff's access to all or some finance app has been revoked.
  fields: (no fields)
- **finance_app_staff_member/update** — Triggers when a staff's information has been updated.
  fields: (no fields)

### finance_kyc_information

- **finance_kyc_information/update** — Occurs whenever shop's finance KYC information was updated
  fields: (no fields)

### fulfillment_events

- **fulfillment_events/create** — Occurs whenever a fulfillment event is created.
  fields: address1 (string|null), admin_graphql_api_id (string:uri), city (string|null), country (string), created_at (string:date-time), estimated_delivery_at (string:date-time|null), fulfillment_id (integer), happened_at (string:date-time), id (integer), latitude (number|null), longitude (number|null), message (string), order_id (integer), province (string|null), shop_id (integer), status (string), updated_at (string:date-time), zip (string|null)
- **fulfillment_events/delete** — Occurs whenever a fulfillment event is deleted.
  fields: address1 (string|null), admin_graphql_api_id (string:uri), city (string|null), country (string), created_at (string:date-time), estimated_delivery_at (string:date-time|null), fulfillment_id (integer), happened_at (string:date-time), id (integer), latitude (number|null), longitude (number|null), message (string), order_id (integer), province (string|null), shop_id (integer), status (string), updated_at (string:date-time), zip (string|null)

### fulfillment_holds

- **fulfillment_holds/added** — Occurs each time that a hold is added to a fulfillment order.

For cases where multiple holds are applied to a fulfillment order, this webhook will trigger after each hold is applied.
  fields: fulfillment_hold (object), fulfillment_order (object)
- **fulfillment_holds/released** — Occurs each time that a hold is released from a fulfillment order.
For cases where multiple holds are released from a fulfillment order a the same time, this webhook will trigger for each released hold.
  fields: fulfillment_hold (object), fulfillment_order (object)

### fulfillment_orders

- **fulfillment_orders/cancellation_request_accepted** — Occurs when a 3PL accepts a fulfillment cancellation request, received from a merchant.
  fields: fulfillment_order (object), message (string)
- **fulfillment_orders/cancellation_request_rejected** — Occurs when a 3PL rejects a fulfillment cancellation request, received from a merchant.
  fields: fulfillment_order (object), message (string)
- **fulfillment_orders/cancellation_request_submitted** — Occurs when a merchant requests a fulfillment request to be cancelled after that request was approved by a 3PL.
  fields: fulfillment_order (object), fulfillment_order_merchant_request (object)
- **fulfillment_orders/cancelled** — Occurs when a fulfillment order is cancelled.
  fields: fulfillment_order (object), replacement_fulfillment_order (object)
- **fulfillment_orders/fulfillment_request_accepted** — Occurs when a fulfillment service accepts a request to fulfill a fulfillment order.
  fields: fulfillment_order (object), message (string)
- **fulfillment_orders/fulfillment_request_rejected** — Occurs when a 3PL rejects a fulfillment request that was sent by a merchant.
  fields: fulfillment_order (object), message (string)
- **fulfillment_orders/fulfillment_request_submitted** — Occurs when a merchant submits a fulfillment request to a 3PL.
  fields: fulfillment_order_merchant_request (object), original_fulfillment_order (object), submitted_fulfillment_order (object)
- **fulfillment_orders/fulfillment_service_failed_to_complete** — Occurs when a fulfillment service intends to close an in_progress fulfillment order.
  fields: fulfillment_order (object), message (string)
- **fulfillment_orders/hold_released** — Occurs when a fulfillment order is released and is no longer on hold.

If a fulfillment order has multiple holds then this webhook will only be triggered once when the last hold is released and the status of the fulfillment order is no longer `ON_HOLD`.
  fields: fulfillment_order (object)
- **fulfillment_orders/line_items_prepared_for_local_delivery** — Occurs whenever a fulfillment order's line items are prepared for local delivery.
  fields: fulfillment_order (object)
- **fulfillment_orders/line_items_prepared_for_pickup** — Triggers when one or more of the line items for a fulfillment order are prepared for pickup
  fields: fulfillment_order (object)
- **fulfillment_orders/manually_reported_progress_stopped** — Occurs when a fulfillment order that has previously been manually marked as in progress is marked back as open.
  fields: fulfillment_order (object), progress_stopped_by_app (object), progress_stopped_by_user (object)
- **fulfillment_orders/merged** — Occurs when multiple fulfillment orders are merged into a single fulfillment order.
  fields: fulfillment_order_merges (object), merge_intents (array<object>)
- **fulfillment_orders/moved** — Occurs whenever the location which is assigned to fulfill one or more fulfillment order line items is changed.

* `original_fulfillment_order` - The final state of the original fulfillment order.
* `moved_fulfillment_order` - The fulfillment order which now contains the re-assigned line items.
* `source_location` - The original location which was assigned to fulfill the line items (available as of the `2023-04` API version).
* `destination_location_id` - The ID of the location which is now responsible for fulfilling the line items.

**Note:** The [assignedLocation](https://shopify.dev/docs/api/admin-graphql/latest/objects/fulfillmentorder#field-fulfillmentorder-assignedlocation)
of the `original_fulfillment_order` might be changed by the move operation.
If you need to determine the originally assigned location, then you should refer to the `source_location`.

[Learn more about moving line items](https://shopify.dev/docs/api/admin-graphql/latest/mutations/fulfillmentOrderMove).
  fields: destination_location_id (string:uri), fulfillment_order_line_items_requested (array<object>), moved_fulfillment_order (object), original_fulfillment_order (object), source_location (object)
- **fulfillment_orders/order_routing_complete** — Occurs when an order has finished being routed and it's fulfillment orders assigned to a fulfillment service's location.
  fields: fulfillment_order (object)
- **fulfillment_orders/placed_on_hold** — Occurs when a fulfillment order transitions to the `ON_HOLD` status

For cases where multiple holds are applied to a fulfillment order, this webhook will only trigger once when the first hold is applied and the fulfillment order status changes to `ON_HOLD`.
  fields: created_fulfillment_hold (object), fulfillment_order (object), held_fulfillment_order_line_items (array<object>), remaining_fulfillment_order (object)
- **fulfillment_orders/progress_reported** — Occurs when progress is reported for a fulfillment order.
  fields: fulfillment_order (object), initial_status (string), progress_report (object)
- **fulfillment_orders/rescheduled** — Triggers when a fulfillment order is rescheduled.

Fulfillment orders may be merged if they have the same `fulfillAt` datetime.
If the fulfillment order is merged then the resulting fulfillment order will be indicated in the webhook body.
Otherwise it will be the original fulfillment order with an updated `fulfill_at` datetime.
  fields: fulfillment_order (object)
- **fulfillment_orders/scheduled_fulfillment_order_ready** — Occurs whenever a fulfillment order which was scheduled becomes due.
  fields: fulfillment_order (object)
- **fulfillment_orders/split** — Occurs when a fulfillment order is split into multiple fulfillment orders.
  fields: fulfillment_order (object), remaining_fulfillment_order (object), replacement_fulfillment_order (object), split_line_items (array<object>)

### fulfillments

- **fulfillments/create** — Occurs whenever a fulfillment is created.
  fields: admin_graphql_api_id (string:uri), created_at (string:date-time), destination (object), email (string:email), id (integer), line_items (array<object>), location_id (integer|null), name (string), order_id (integer), origin_address (unknown), receipt (object), service (string|null), shipment_status (string|null), status (string), tracking_company (string), tracking_number (string), tracking_numbers (array<string>), tracking_url (string:uri), tracking_urls (array<string>), updated_at (string:date-time)
- **fulfillments/update** — Occurs whenever a fulfillment is updated.
  fields: admin_graphql_api_id (string:uri), created_at (string:date-time), destination (object), email (string:email), id (integer), line_items (array<object>), location_id (integer|null), name (string), order_id (integer), origin_address (unknown), receipt (object), service (string|null), shipment_status (string|null), status (string), tracking_company (string), tracking_number (string), tracking_numbers (array<string>), tracking_url (string:uri), tracking_urls (array<string>), updated_at (string:date-time)

### inventory_items

- **inventory_items/create** — Occurs whenever an inventory item is created.
  fields: admin_graphql_api_id (string:uri), cost (unknown), country_code_of_origin (string|null), country_harmonized_system_codes (array), created_at (string:date-time), harmonized_system_code (string|null), id (integer), province_code_of_origin (string|null), requires_shipping (boolean), sku (string), tracked (boolean), updated_at (string:date-time), weight_unit (string), weight_value (integer)
- **inventory_items/delete** — Occurs whenever an inventory item is deleted.
  fields: admin_graphql_api_id (string:uri), country_code_of_origin (string|null), country_harmonized_system_codes (array), harmonized_system_code (string|null), id (integer), province_code_of_origin (string|null)
- **inventory_items/update** — Occurs whenever an inventory item is updated.
  fields: admin_graphql_api_id (string:uri), cost (unknown), country_code_of_origin (string|null), country_harmonized_system_codes (array), created_at (string:date-time), harmonized_system_code (string|null), id (integer), province_code_of_origin (string|null), requires_shipping (boolean), sku (string), tracked (boolean), updated_at (string:date-time), weight_unit (string), weight_value (integer)

### inventory_levels

- **inventory_levels/connect** — Occurs whenever an inventory level is connected.
  fields: admin_graphql_api_id (string:uri), available (integer|null), inventory_item_id (integer), location_id (integer), updated_at (string:date-time)
- **inventory_levels/disconnect** — Occurs whenever an inventory level is disconnected.
  fields: inventory_item_id (integer), location_id (integer)
- **inventory_levels/update** — Occurs whenever an inventory level is updated.
  fields: admin_graphql_api_id (string:uri), available (integer|null), inventory_item_id (integer), location_id (integer), updated_at (string:date-time)

### inventory_shipments

- **inventory_shipments/add_items** — Occurs whenever items are added to a shipment.
  fields: happened_at (string:date-time), id (string:uri), items_added (array<object>)
- **inventory_shipments/create** — Triggers when a shipment is created.
  fields: happened_at (string:date-time), id (string:uri), line_items (array<object>), status (string), tracking (object)
- **inventory_shipments/delete** — Triggers when a shipment is deleted.
  fields: happened_at (string:date-time), id (string:uri)
- **inventory_shipments/mark_in_transit** — Triggers when a shipment is marked as in transit.
  fields: happened_at (string:date-time), id (string:uri), status (string)
- **inventory_shipments/receive_items** — Triggers when items on a shipment are received.
  fields: happened_at (string:date-time), id (string:uri), items_received (array<object>), status (string)
- **inventory_shipments/remove_items** — Occurs whenever items are removed from a shipment.
  fields: happened_at (string:date-time), id (string:uri), items_removed (array<object>)
- **inventory_shipments/update_item_quantities** — Occurs whenever quantities change on a shipment.
  fields: happened_at (string:date-time), id (string:uri), items_updated (array<object>)
- **inventory_shipments/update_tracking** — Triggers when tracking info on a shipment is updated.
  fields: happened_at (string:date-time), shipment_id (string:uri), updated_tracking (object)

### inventory_transfers

- **inventory_transfers/add_items** — Occurs any time items are added to a transfer.
  fields: happened_at (string:date-time), id (string:uri), items_added (array<object>)
- **inventory_transfers/cancel** — Triggers when a transfer is canceled.
  fields: happened_at (string:date-time), id (string:uri), status (string)
- **inventory_transfers/complete** — Triggers when a transfer is completed.
  fields: happened_at (string:date-time), id (string:uri), status (string)
- **inventory_transfers/ready_to_ship** — Triggers when a transfer is marked as ready to ship.
  fields: happened_at (string:date-time), id (string:uri), line_items (array<object>), status (string)
- **inventory_transfers/remove_items** — Occurs any time items are removed from a transfer.
  fields: happened_at (string:date-time), id (string:uri), items_removed (array<object>)
- **inventory_transfers/update_item_quantities** — Occurs whenever the quantity of transfer line items changes.
  fields: happened_at (string:date-time), id (string:uri), items_updated (array<object>), status (string)

### locales

- **locales/create** — Occurs whenever a shop locale is created
  fields: locale (string), published (boolean)
- **locales/destroy** — Occurs whenever a shop locale is destroyed
  fields: locale (string), published (boolean)
- **locales/update** — Occurs whenever a shop locale is updated, such as published or unpublished
  fields: locale (string), published (boolean)

### locations

- **locations/activate** — Occurs whenever a deactivated location is re-activated.
  fields: active (boolean), address1 (string), address2 (string), admin_graphql_api_id (string:uri), city (string), country (string), country_code (string), country_name (string), created_at (string:date-time), id (integer), legacy (boolean), name (string), phone (string), province (string), province_code (string), updated_at (string:date-time), zip (string)
- **locations/create** — Occurs whenever a location is created.
  fields: active (boolean), address1 (string), address2 (string), admin_graphql_api_id (string:uri), city (string), country (string), country_code (string), country_name (string), created_at (string:date-time), id (integer), legacy (boolean), name (string), phone (string), province (string), province_code (string), updated_at (string:date-time), zip (string)
- **locations/deactivate** — Occurs whenever a location is deactivated.
  fields: active (boolean), address1 (string), address2 (string), admin_graphql_api_id (string:uri), city (string), country (string), country_code (string), country_name (string), created_at (string:date-time), id (integer), legacy (boolean), name (string), phone (string), province (string), province_code (string), updated_at (string:date-time), zip (string)
- **locations/delete** — Occurs whenever a location is deleted.
  fields: id (integer)
- **locations/update** — Occurs whenever a location is updated.
  fields: active (boolean), address1 (string), address2 (string), admin_graphql_api_id (string:uri), city (string), country (string), country_code (string), country_name (string), created_at (string:date-time), id (integer), legacy (boolean), name (string), phone (string), province (string), province_code (string), updated_at (string:date-time), zip (string)

### markets

- **markets/create** — Occurs when a new market is created.
  fields: id (integer), name (string), status (string), type (string)
- **markets/delete** — Occurs when a market is deleted.
  fields: id (integer)
- **markets/update** — Occurs when a market is updated.
  fields: id (integer), name (string), status (string), type (string)

### markets_backup_region

- **markets_backup_region/update** — Occurs when a backup region is updated.
  fields: admin_graphql_api_id (string:uri), code (string)

### metafield_definitions

- **metafield_definitions/create** — Occurs when a metafield definition is created.
  fields: access_only (boolean), admin_filter_status (string), admin_filterable (boolean), admin_filterable_status (null), api_client_id (null), app_config_managed (boolean), created_at (string:date-time|null), customer_access (null), deleting (boolean), description (null), id (null), key (string), merchant_writeable (null), name (string), namespace (string), namespace_owner_api_client_id (null), option_linkable (boolean), options (array), owner_type (string), pinned_position (integer), shop_id (integer), smart_collection_condition (boolean), standard_template_id (null), storefront_readable (null), type_name (string), unique_values (boolean), updated_at (string:date-time|null), use_as_collection_condition (boolean), validation_status (string)
- **metafield_definitions/delete** — Occurs when a metafield definition is deleted.
  fields: created_by_app_id (null), id (string:uri), type (string)
- **metafield_definitions/update** — Occurs when a metafield definition is updated.
  fields: access_only (boolean), admin_filter_status (string), admin_filterable (boolean), admin_filterable_status (null), api_client_id (null), app_config_managed (boolean), created_at (string:date-time|null), customer_access (null), deleting (boolean), description (null), id (null), key (string), merchant_writeable (null), name (string), namespace (string), namespace_owner_api_client_id (null), option_linkable (boolean), options (array), owner_type (string), pinned_position (integer), shop_id (integer), smart_collection_condition (boolean), standard_template_id (null), storefront_readable (null), type_name (string), unique_values (boolean), updated_at (string:date-time|null), use_as_collection_condition (boolean), validation_status (string)

### metaobjects

- **metaobjects/create** — Occurs when a metaobject is created.
  fields: capabilities (object), created_at (string:date-time), created_by_app_id (string:uri), created_by_staff_id (string:uri), definition_id (string:uri), display_name (string), fields (object), handle (string), id (string:uri), type (string), updated_at (string:date-time)
- **metaobjects/delete** — Occurs when a metaobject is deleted.
  fields: created_by_app_id (string:uri), handle (string), id (string:uri), type (string)
- **metaobjects/update** — Occurs when a metaobject is updated.
  fields: capabilities (object), created_at (string:date-time), created_by_app_id (string:uri), created_by_staff_id (string:uri), definition_id (string:uri), display_name (string), fields (object), handle (string), id (string:uri), type (string), updated_at (string:date-time)

### order_transactions

- **order_transactions/create** — Occurs when a order transaction is created or when it's status is updated. Only occurs for transactions with a status of success, failure or error.
  fields: admin_graphql_api_id (string:uri), amount (string), amount_rounding (string|null), authorization (string), created_at (string:date-time), currency (string), device_id (unknown), error_code (string|null), gateway (string), id (integer), kind (string), location_id (integer|null), manual_payment_gateway (boolean), message (string|null), order_id (integer), parent_id (integer|null), payment_details (object), payment_id (string), processed_at (string:date-time|null), receipt (object), source_name (string), status (string), test (boolean), total_unsettled_set (object), user_id (integer|null)

### orders

- **orders/cancelled** — Occurs whenever an order is cancelled.
  fields: admin_graphql_api_id (string:uri), app_id (integer|null), billing_address (object), browser_ip (string:ipv4|null), buyer_accepts_marketing (boolean), cancel_reason (string|null), cancelled_at (string:date-time|null), cart_token (string|null), checkout_token (string|null), client_details (object|null), closed_at (string:date-time|null), company (object|null), confirmation_number (string|null), confirmed (boolean), contact_email (string:email), created_at (string:date-time), currency (string), current_shipping_price_set (object), current_subtotal_price (string), current_subtotal_price_set (object), current_total_additional_fees_set (object|null), current_total_discounts (string), current_total_discounts_set (object), current_total_duties_set (object|null), current_total_price (string), current_total_price_set (object), current_total_tax (string), current_total_tax_set (object), customer (object), customer_locale (string|null), device_id (string|null), discount_applications (array<object>), discount_codes (array<object>), duties_included (boolean), email (string:email), estimated_taxes (boolean), financial_status (string), fulfillment_status (string|null), fulfillments (array<object>), id (integer), landing_site (string|null), landing_site_ref (string:uri|null), line_item_groups (array), line_items (array<object>), location_id (integer|null), merchant_business_entity_id (string), merchant_of_record_app_id (integer|null), name (string), note (string|null), note_attributes (array<object>), number (integer), order_number (integer), order_status_url (string:uri), original_total_additional_fees_set (object|null), original_total_duties_set (object|null), payment_gateway_names (array<string>), payment_terms (string|null), phone (string|null), po_number (string|null), presentment_currency (string), processed_at (string:date-time), reference (string|null), referring_site (string|null), refunds (array), returns (array), shipping_address (object), shipping_lines (array<object>), source_identifier (string|null), source_name (string), source_url (string:uri|null), subtotal_price (string), subtotal_price_set (object), tags (string), tax_exempt (boolean), tax_lines (array<object>), taxes_included (boolean), test (boolean), token (string), total_cash_rounding_payment_adjustment_set (object), total_cash_rounding_refund_adjustment_set (object), total_discounts (string), total_discounts_set (object), total_line_items_price (string), total_line_items_price_set (object), total_outstanding (string), total_price (string), total_price_set (object), total_shipping_price_set (object), total_tax (string), total_tax_set (object), total_tip_received (string), total_weight (integer), updated_at (string:date-time), user_id (integer|null)
- **orders/create** — Occurs whenever an order is created.
  fields: admin_graphql_api_id (string:uri), app_id (integer|null), billing_address (object), browser_ip (string:ipv4|null), buyer_accepts_marketing (boolean), cancel_reason (string|null), cancelled_at (string:date-time|null), cart_token (string|null), checkout_token (string|null), client_details (object|null), closed_at (string:date-time|null), company (object|null), confirmation_number (string|null), confirmed (boolean), contact_email (string:email), created_at (string:date-time), currency (string), current_shipping_price_set (object), current_subtotal_price (string), current_subtotal_price_set (object), current_total_additional_fees_set (object|null), current_total_discounts (string), current_total_discounts_set (object), current_total_duties_set (object|null), current_total_price (string), current_total_price_set (object), current_total_tax (string), current_total_tax_set (object), customer (object), customer_locale (string|null), device_id (string|null), discount_applications (array<object>), discount_codes (array<object>), duties_included (boolean), email (string:email), estimated_taxes (boolean), financial_status (string), fulfillment_status (string|null), fulfillments (array<object>), id (integer), landing_site (string|null), landing_site_ref (string:uri|null), line_item_groups (array), line_items (array<object>), location_id (integer|null), merchant_business_entity_id (string), merchant_of_record_app_id (integer|null), name (string), note (string|null), note_attributes (array<object>), number (integer), order_number (integer), order_status_url (string:uri), original_total_additional_fees_set (object|null), original_total_duties_set (object|null), payment_gateway_names (array<string>), payment_terms (string|null), phone (string|null), po_number (string|null), presentment_currency (string), processed_at (string:date-time), reference (string|null), referring_site (string|null), refunds (array), returns (array), shipping_address (object), shipping_lines (array<object>), source_identifier (string|null), source_name (string), source_url (string:uri|null), subtotal_price (string), subtotal_price_set (object), tags (string), tax_exempt (boolean), tax_lines (array<object>), taxes_included (boolean), test (boolean), token (string), total_cash_rounding_payment_adjustment_set (object), total_cash_rounding_refund_adjustment_set (object), total_discounts (string), total_discounts_set (object), total_line_items_price (string), total_line_items_price_set (object), total_outstanding (string), total_price (string), total_price_set (object), total_shipping_price_set (object), total_tax (string), total_tax_set (object), total_tip_received (string), total_weight (integer), updated_at (string:date-time), user_id (integer|null)
- **orders/delete** — Occurs whenever an order is deleted.
  fields: id (integer)
- **orders/edited** — Occurs whenever an order is edited.
  fields: order_edit (object)
- **orders/fulfilled** — Occurs whenever an order is fulfilled.
  fields: admin_graphql_api_id (string:uri), app_id (integer|null), billing_address (object), browser_ip (string:ipv4|null), buyer_accepts_marketing (boolean), cancel_reason (string|null), cancelled_at (string:date-time|null), cart_token (string|null), checkout_token (string|null), client_details (object|null), closed_at (string:date-time|null), company (object|null), confirmation_number (string|null), confirmed (boolean), contact_email (string:email), created_at (string:date-time), currency (string), current_shipping_price_set (object), current_subtotal_price (string), current_subtotal_price_set (object), current_total_additional_fees_set (object|null), current_total_discounts (string), current_total_discounts_set (object), current_total_duties_set (object|null), current_total_price (string), current_total_price_set (object), current_total_tax (string), current_total_tax_set (object), customer (object), customer_locale (string|null), device_id (string|null), discount_applications (array<object>), discount_codes (array<object>), duties_included (boolean), email (string:email), estimated_taxes (boolean), financial_status (string), fulfillment_status (string|null), fulfillments (array<object>), id (integer), landing_site (string|null), landing_site_ref (string:uri|null), line_item_groups (array), line_items (array<object>), location_id (integer|null), merchant_business_entity_id (string), merchant_of_record_app_id (integer|null), name (string), note (string|null), note_attributes (array<object>), number (integer), order_number (integer), order_status_url (string:uri), original_total_additional_fees_set (object|null), original_total_duties_set (object|null), payment_gateway_names (array<string>), payment_terms (string|null), phone (string|null), po_number (string|null), presentment_currency (string), processed_at (string:date-time), reference (string|null), referring_site (string|null), refunds (array), returns (array), shipping_address (object), shipping_lines (array<object>), source_identifier (string|null), source_name (string), source_url (string:uri|null), subtotal_price (string), subtotal_price_set (object), tags (string), tax_exempt (boolean), tax_lines (array<object>), taxes_included (boolean), test (boolean), token (string), total_cash_rounding_payment_adjustment_set (object), total_cash_rounding_refund_adjustment_set (object), total_discounts (string), total_discounts_set (object), total_line_items_price (string), total_line_items_price_set (object), total_outstanding (string), total_price (string), total_price_set (object), total_shipping_price_set (object), total_tax (string), total_tax_set (object), total_tip_received (string), total_weight (integer), updated_at (string:date-time), user_id (integer|null)
- **orders/link_requested** — Occurs whenever a customer requests a new order link from the expired order status page.
  fields: admin_graphql_api_id (string:uri), app_id (integer|null), billing_address (object), browser_ip (string:ipv4|null), buyer_accepts_marketing (boolean), cancel_reason (string|null), cancelled_at (string:date-time|null), cart_token (string|null), checkout_token (string|null), client_details (object|null), closed_at (string:date-time|null), confirmation_number (string|null), confirmed (boolean), contact_email (string:email), created_at (string:date-time), currency (string), current_shipping_price_set (object), current_subtotal_price (string), current_subtotal_price_set (object), current_total_additional_fees_set (object|null), current_total_discounts (string), current_total_discounts_set (object), current_total_duties_set (object|null), current_total_price (string), current_total_price_set (object), current_total_tax (string), current_total_tax_set (object), customer (object), customer_locale (string|null), device_id (string|null), discount_applications (array<object>), discount_codes (array<object>), duties_included (boolean), email (string:email), estimated_taxes (boolean), financial_status (string), fulfillment_status (string|null), fulfillments (array<object>), id (integer), landing_site (string|null), landing_site_ref (string:uri|null), line_item_groups (array), line_items (array<object>), location_id (integer|null), merchant_business_entity_id (string), merchant_of_record_app_id (integer|null), name (string), note (string|null), note_attributes (array<object>), number (integer), order_number (integer), order_status_url (string:uri), original_total_additional_fees_set (object|null), original_total_duties_set (object|null), payment_gateway_names (array<string>), payment_terms (string|null), phone (string|null), po_number (string|null), presentment_currency (string), processed_at (string:date-time), reference (string|null), referring_site (string|null), refunds (array), returns (array), shipping_address (object), shipping_lines (array<object>), source_identifier (string|null), source_name (string), source_url (string:uri|null), subtotal_price (string), subtotal_price_set (object), tags (string), tax_exempt (boolean), tax_lines (array<object>), taxes_included (boolean), test (boolean), token (string), total_cash_rounding_payment_adjustment_set (object), total_cash_rounding_refund_adjustment_set (object), total_discounts (string), total_discounts_set (object), total_line_items_price (string), total_line_items_price_set (object), total_outstanding (string), total_price (string), total_price_set (object), total_shipping_price_set (object), total_tax (string), total_tax_set (object), total_tip_received (string), total_weight (integer), updated_at (string:date-time), user_id (integer|null)
- **orders/paid** — Occurs whenever an order is paid.
  fields: admin_graphql_api_id (string:uri), app_id (integer|null), billing_address (object), browser_ip (string:ipv4|null), buyer_accepts_marketing (boolean), cancel_reason (string|null), cancelled_at (string:date-time|null), cart_token (string|null), checkout_token (string|null), client_details (object|null), closed_at (string:date-time|null), company (object|null), confirmation_number (string|null), confirmed (boolean), contact_email (string:email), created_at (string:date-time), currency (string), current_shipping_price_set (object), current_subtotal_price (string), current_subtotal_price_set (object), current_total_additional_fees_set (object|null), current_total_discounts (string), current_total_discounts_set (object), current_total_duties_set (object|null), current_total_price (string), current_total_price_set (object), current_total_tax (string), current_total_tax_set (object), customer (object), customer_locale (string|null), device_id (string|null), discount_applications (array<object>), discount_codes (array<object>), duties_included (boolean), email (string:email), estimated_taxes (boolean), financial_status (string), fulfillment_status (string|null), fulfillments (array<object>), id (integer), landing_site (string|null), landing_site_ref (string:uri|null), line_item_groups (array), line_items (array<object>), location_id (integer|null), merchant_business_entity_id (string), merchant_of_record_app_id (integer|null), name (string), note (string|null), note_attributes (array<object>), number (integer), order_number (integer), order_status_url (string:uri), original_total_additional_fees_set (object|null), original_total_duties_set (object|null), payment_gateway_names (array<string>), payment_terms (string|null), phone (string|null), po_number (string|null), presentment_currency (string), processed_at (string:date-time), reference (string|null), referring_site (string|null), refunds (array), returns (array), shipping_address (object), shipping_lines (array<object>), source_identifier (string|null), source_name (string), source_url (string:uri|null), subtotal_price (string), subtotal_price_set (object), tags (string), tax_exempt (boolean), tax_lines (array<object>), taxes_included (boolean), test (boolean), token (string), total_cash_rounding_payment_adjustment_set (object), total_cash_rounding_refund_adjustment_set (object), total_discounts (string), total_discounts_set (object), total_line_items_price (string), total_line_items_price_set (object), total_outstanding (string), total_price (string), total_price_set (object), total_shipping_price_set (object), total_tax (string), total_tax_set (object), total_tip_received (string), total_weight (integer), updated_at (string:date-time), user_id (integer|null)
- **orders/partially_fulfilled** — Occurs whenever an order is partially fulfilled.
  fields: admin_graphql_api_id (string:uri), app_id (integer|null), billing_address (object), browser_ip (string:ipv4|null), buyer_accepts_marketing (boolean), cancel_reason (string|null), cancelled_at (string:date-time|null), cart_token (string|null), checkout_token (string|null), client_details (object|null), closed_at (string:date-time|null), company (object|null), confirmation_number (string|null), confirmed (boolean), contact_email (string:email), created_at (string:date-time), currency (string), current_shipping_price_set (object), current_subtotal_price (string), current_subtotal_price_set (object), current_total_additional_fees_set (object|null), current_total_discounts (string), current_total_discounts_set (object), current_total_duties_set (object|null), current_total_price (string), current_total_price_set (object), current_total_tax (string), current_total_tax_set (object), customer (object), customer_locale (string|null), device_id (string|null), discount_applications (array<object>), discount_codes (array<object>), duties_included (boolean), email (string:email), estimated_taxes (boolean), financial_status (string), fulfillment_status (string|null), fulfillments (array<object>), id (integer), landing_site (string|null), landing_site_ref (string:uri|null), line_item_groups (array), line_items (array<object>), location_id (integer|null), merchant_business_entity_id (string), merchant_of_record_app_id (integer|null), name (string), note (string|null), note_attributes (array<object>), number (integer), order_number (integer), order_status_url (string:uri), original_total_additional_fees_set (object|null), original_total_duties_set (object|null), payment_gateway_names (array<string>), payment_terms (string|null), phone (string|null), po_number (string|null), presentment_currency (string), processed_at (string:date-time), reference (string|null), referring_site (string|null), refunds (array), returns (array), shipping_address (object), shipping_lines (array<object>), source_identifier (string|null), source_name (string), source_url (string:uri|null), subtotal_price (string), subtotal_price_set (object), tags (string), tax_exempt (boolean), tax_lines (array<object>), taxes_included (boolean), test (boolean), token (string), total_cash_rounding_payment_adjustment_set (object), total_cash_rounding_refund_adjustment_set (object), total_discounts (string), total_discounts_set (object), total_line_items_price (string), total_line_items_price_set (object), total_outstanding (string), total_price (string), total_price_set (object), total_shipping_price_set (object), total_tax (string), total_tax_set (object), total_tip_received (string), total_weight (integer), updated_at (string:date-time), user_id (integer|null)
- **orders/risk_assessment_changed** — Triggers when a new risk assessment is available on the order.
This can be the first or a subsequent risk assessment.
New risk assessments can be provided until the order is marked as fulfilled.
Includes the risk level, risk facts, the provider and the order ID.
When the provider is Shopify, that field is null.
Does not include the risk recommendation for the order.
The Shop ID is available in the headers.
  fields: admin_graphql_api_order_id (string:uri|null), created_at (string:date-time|null), order_id (string|null), provider_id (integer|null), provider_title (string|null), risk_level (string)
- **orders/shopify_protect_eligibility_changed** — Occurs whenever Shopify Protect's eligibility for an order is changed.
  fields: eligibility (object), order_id (unknown), status (string)
- **orders/updated** — Occurs whenever an order is updated.
  fields: admin_graphql_api_id (string:uri), app_id (integer|null), billing_address (object), browser_ip (string:ipv4|null), buyer_accepts_marketing (boolean), cancel_reason (string|null), cancelled_at (string:date-time|null), cart_token (string|null), checkout_token (string|null), client_details (object|null), closed_at (string:date-time|null), company (object|null), confirmation_number (string|null), confirmed (boolean), contact_email (string:email), created_at (string:date-time), currency (string), current_shipping_price_set (object), current_subtotal_price (string), current_subtotal_price_set (object), current_total_additional_fees_set (object|null), current_total_discounts (string), current_total_discounts_set (object), current_total_duties_set (object|null), current_total_price (string), current_total_price_set (object), current_total_tax (string), current_total_tax_set (object), customer (object), customer_locale (string|null), device_id (string|null), discount_applications (array<object>), discount_codes (array<object>), duties_included (boolean), email (string:email), estimated_taxes (boolean), financial_status (string), fulfillment_status (string|null), fulfillments (array<object>), id (integer), landing_site (string|null), landing_site_ref (string:uri|null), line_item_groups (array), line_items (array<object>), location_id (integer|null), merchant_business_entity_id (string), merchant_of_record_app_id (integer|null), name (string), note (string|null), note_attributes (array<object>), number (integer), order_number (integer), order_status_url (string:uri), original_total_additional_fees_set (object|null), original_total_duties_set (object|null), payment_gateway_names (array<string>), payment_terms (string|null), phone (string|null), po_number (string|null), presentment_currency (string), processed_at (string:date-time), reference (string|null), referring_site (string|null), refunds (array), returns (array), shipping_address (object), shipping_lines (array<object>), source_identifier (string|null), source_name (string), source_url (string:uri|null), subtotal_price (string), subtotal_price_set (object), tags (string), tax_exempt (boolean), tax_lines (array<object>), taxes_included (boolean), test (boolean), token (string), total_cash_rounding_payment_adjustment_set (object), total_cash_rounding_refund_adjustment_set (object), total_discounts (string), total_discounts_set (object), total_line_items_price (string), total_line_items_price_set (object), total_outstanding (string), total_price (string), total_price_set (object), total_shipping_price_set (object), total_tax (string), total_tax_set (object), total_tip_received (string), total_weight (integer), updated_at (string:date-time), user_id (integer|null)

### payment_schedules

- **payment_schedules/due** — Occurs whenever payment schedules are due.
  fields: admin_graphql_api_id (string:uri), amount (string), balance_due (string), completed_at (string:date-time), created_at (string:date-time), currency (string), due_at (string:date-time), id (integer), issued_at (string:date-time), payment_terms_id (integer), presentment_currency (string), total_balance (string), total_price (string), updated_at (string:date-time)

### payment_terms

- **payment_terms/create** — Occurs whenever payment terms are created.
  fields: admin_graphql_api_id (string:uri), created_at (string:date-time), due_in_days (integer), id (integer), payment_schedules (array<object>), payment_terms_name (string), payment_terms_type (string), updated_at (string:date-time)
- **payment_terms/delete** — Occurs whenever payment terms are deleted.
  fields: id (integer)
- **payment_terms/update** — Occurs whenever payment terms are updated.
  fields: admin_graphql_api_id (string:uri), created_at (string:date-time), due_in_days (integer), id (integer), payment_schedules (array<object>), payment_terms_name (string), payment_terms_type (string), updated_at (string:date-time)

### product_feeds

- **product_feeds/create** — Triggers when product feed is created
  fields: country (string), id (string:uri), language (string), status (string)
- **product_feeds/full_sync** — Triggers when a full sync for a product feed is performed
  fields: metadata (object), product (object), productFeed (object), products (null)
- **product_feeds/full_sync_finish** — Triggers when a full sync finishes
  fields: fullSync (object), metadata (object), productFeed (object)
- **product_feeds/incremental_sync** — Occurs whenever a product publication is created, updated or removed for a product feed
  fields: metadata (object), product (object), productFeed (object), products (null)
- **product_feeds/update** — Triggers when product feed is updated
  fields: country (string), id (string:uri), language (string), status (string)

### product_listings

- **product_listings/add** — Occurs whenever an active product is listed on a channel.
  fields: product_listing (object)
- **product_listings/remove** — Occurs whenever a product listing is removed from the channel.
  fields: product_listing (object)
- **product_listings/update** — Occurs whenever a product publication is updated.
  fields: product_listing (object)

### product_publications

- **product_publications/create** — Occurs whenever a product publication for an active product is created, or whenever an existing product publication is published on the app that is subscribed to this webhook topic. Note that a webhook is only emitted when there are publishing changes to the app that is subscribed to the topic (ie. no webhook will be emitted if there is a publishing change to the online store and the webhook subscriber of the topic is a third-party app).
  fields: created_at (string:date-time|null), id (null), product_id (integer), publication_id (integer), published (boolean), published_at (string:date-time), updated_at (string:date-time|null)
- **product_publications/delete** — Occurs whenever a product publication for an active product is removed, or whenever an existing product publication is unpublished from the app that is subscribed to this webhook topic. Note that a webhook is only emitted when there are publishing changes to the app that is subscribed to the topic (ie. no webhook will be emitted if there is a publishing change to the online store and the webhook subscriber of the topic is a third-party app).
  fields: id (null)
- **product_publications/update** — Occurs whenever a product publication is updated from the app that is subscribed to this webhook topic. Note that a webhook is only emitted when there are publishing changes to the app that is subscribed to the topic (ie. no webhook will be emitted if there is a publishing change to the online store and the webhook subscriber of the topic is a third-party app).
  fields: created_at (string:date-time|null), id (null), product_id (integer), publication_id (integer), published (boolean), published_at (string:date-time), updated_at (string:date-time|null)

### products

- **products/create** — Occurs whenever a product is created. Product webhooks will return a full variants payload for the first 100 records. For records 101 and higher, the payload won't include the full variant details, but the `variant_gids` field will still include a `admin_graphql_api_id` value for these variants. `variant_gids` are sorted by `updated_at`, with the gids for recently updated variants appearing first.
  fields: admin_graphql_api_id (string:uri), body_html (string), category (object|null), created_at (string:date-time|null), handle (string), has_variants_that_requires_components (boolean), id (integer), image (object), images (array<object>), media (array<object>), options (array<object>), product_type (string), published_at (string:date-time|null), published_scope (string), status (string), tags (string), template_suffix (string|null), title (string), updated_at (string:date-time), variant_gids (array<object>), variants (array<object>), vendor (string)
- **products/delete** — Occurs whenever a product is deleted.
  fields: id (integer)
- **products/update** — Occurs whenever a product is updated, ordered, or variants are added, removed or updated. Product webhooks will return a full variants payload for the first 100 records. For records 101 and higher, the payload won't include the full variant details, but the `variant_gids` field will still include a `admin_graphql_api_id` value for these variants. `variant_gids` are sorted by `updated_at`, with the gids for recently updated variants appearing first.
  fields: admin_graphql_api_id (string:uri), body_html (string), category (object|null), created_at (string:date-time|null), handle (string), has_variants_that_requires_components (boolean), id (integer), image (object), images (array<object>), media (array<object>), options (array<object>), product_type (string), published_at (string:date-time|null), published_scope (string), status (string), tags (string), template_suffix (string|null), title (string), updated_at (string:date-time), variant_gids (array<object>), variants (array<object>), vendor (string)

### profiles

- **profiles/create** — Occurs whenever a delivery profile is created
  fields: admin_graphql_api_id (string:uri), default (boolean), id (integer), name (string), profile_type (null), version (integer)
- **profiles/delete** — Occurs whenever a delivery profile is deleted
  fields: admin_graphql_api_id (string:uri), default (boolean), id (integer), name (string), profile_type (null), version (integer)
- **profiles/update** — Occurs whenever a delivery profile is updated
  fields: admin_graphql_api_id (string:uri), default (boolean), id (integer), name (string), profile_type (null), version (integer)

### refunds

- **refunds/create** — Occurs whenever a new refund is created without errors on an order, independent from the movement of money.
  fields: admin_graphql_api_id (string:uri), created_at (string:date-time), duties (array), id (integer), note (string), order_adjustments (array<object>), order_id (integer), processed_at (string:date-time), refund_line_items (array<object>), refund_shipping_lines (array), restock (boolean), return (unknown), total_duties_set (object), transactions (array<object>), user_id (integer)

### returns

- **returns/approve** — Occurs whenever a return is approved. This means `Return.status` is `OPEN`.
  fields: admin_graphql_api_id (string:uri), exchange_line_items (array<object>), id (integer), name (null), order (object), return_line_items (array), return_shipping_fees (array<object>), status (string), total_exchange_line_items (integer), total_return_line_items (integer)
- **returns/cancel** — Occurs whenever a return is canceled.
  fields: admin_graphql_api_id (string:uri), id (integer), order_id (integer), status (string)
- **returns/close** — Occurs whenever a return is closed.
  fields: admin_graphql_api_id (string:uri), id (integer), order_id (integer), status (string)
- **returns/decline** — Occurs whenever a return is declined. This means `Return.status` is `DECLINED`.
  fields: admin_graphql_api_id (string:uri), decline (object), id (integer), order (object), status (string)
- **returns/process** — Occurs whenever a return is processed.
  fields: (no fields)
- **returns/reopen** — Occurs whenever a closed return is reopened.
  fields: admin_graphql_api_id (string:uri), id (integer), order_id (integer), status (string)
- **returns/request** — Occurs whenever a return is requested. This means `Return.status` is `REQUESTED`.
  fields: admin_graphql_api_id (string:uri), exchange_line_items (array), id (integer), name (null), order (object), return_line_items (array), return_shipping_fees (array), status (string), total_exchange_line_items (integer), total_return_line_items (integer)
- **returns/update** — Occurs whenever a return is updated.
  fields: admin_graphql_api_id (string:uri), restocking_fees (object), return_line_items (object), return_shipping_fees (object)

### reverse_deliveries

- **reverse_deliveries/attach_deliverable** — Occurs whenever a deliverable is attached to a reverse delivery.
This occurs when a reverse delivery is created or updated with delivery metadata.
Metadata includes the delivery method, label, and tracking information associated with a reverse delivery.
  fields: admin_graphql_api_id (string:uri), id (integer), return (object), shipping_deliverable (object)

### reverse_fulfillment_orders

- **reverse_fulfillment_orders/dispose** — Occurs whenever a disposition is made on a reverse fulfillment order.
This includes dispositions made on reverse deliveries that are associated with the reverse fulfillment order.
  fields: admin_graphql_api_id (string:uri), dispositions (array<object>), id (integer), total_dispositions (integer)

### scheduled_product_listings

- **scheduled_product_listings/add** — Occurs whenever a product is scheduled to be published.
  fields: scheduled_product_listing (object)
- **scheduled_product_listings/remove** — Occurs whenever a product is no longer scheduled to be published.
  fields: scheduled_product_listing (object)
- **scheduled_product_listings/update** — Occurs whenever a product's scheduled availability date changes.
  fields: scheduled_product_listing (object)

### segments

- **segments/create** — Occurs whenever a segment is created.
  fields: creationDate (string:date-time), id (integer), lastEditDate (string:date-time), name (string), query (string)
- **segments/delete** — Occurs whenever a segment is deleted.
  fields: id (integer)
- **segments/update** — Occurs whenever a segment is updated.
  fields: creationDate (string:date-time), id (integer), lastEditDate (string:date-time), name (string), query (string)

### selling_plan_groups

- **selling_plan_groups/create** — Notifies when a SellingPlanGroup is created.
  fields: admin_graphql_api_app (string:uri), admin_graphql_api_id (string:uri), app_id (unknown), description (string|null), id (integer), merchant_code (string), name (string), options (array<string>), position (integer|null), product_variants (array), products (array<object>), selling_plans (array<object>), summary (string)
- **selling_plan_groups/delete** — Notifies when a SellingPlanGroup is deleted.
  fields: admin_graphql_api_id (string:uri), id (integer)
- **selling_plan_groups/update** — Notifies when a SellingPlanGroup is updated.
  fields: admin_graphql_api_app (string:uri), admin_graphql_api_id (string:uri), app_id (unknown), description (string|null), id (integer), merchant_code (string), name (string), options (array<string>), position (integer|null), product_variants (array), products (array<object>), selling_plans (array<object>), summary (string)

### shipping_addresses

- **shipping_addresses/create** — Occurs whenever a shipping address is created.
  fields: address1 (string|null), address2 (string|null), city (string|null), company (string|null), country (string|null), country_code (string|null), first_name (string|null), last_name (string|null), latitude (number|null), longitude (number|null), name (string|null), phone (string|null), province (string|null), province_code (string|null), zip (string|null)
- **shipping_addresses/update** — Occurs whenever a shipping address is updated.
  fields: address1 (string|null), address2 (string|null), city (string|null), company (string|null), country (string|null), country_code (string|null), first_name (string|null), last_name (string|null), latitude (number|null), longitude (number|null), name (string|null), phone (string|null), province (string|null), province_code (string|null), zip (string|null)

### shop

- **shop/redact** — 48 hours after a store owner uninstalls your app, Shopify sends a payload on the shop/redact topic. This webhook provides the store's shop_id and shop_domain so that you can erase data for that store from your database.

While testing with this topic in development, note that the corresponding event on your test shop will not result in a webhook triggering immediately. shop/redact webhooks are emitted no earlier than 48 hours after uninstalling the app, and they do not fire if the app has been re-installed again.
  fields: shop_domain (string), shop_id (integer)
- **shop/update** — Occurs whenever a shop is updated.
  fields: address1 (string), address2 (string|null), auto_configure_tax_inclusivity (boolean|null), checkout_api_supported (boolean), city (string), country (string), country_code (string), country_name (string), county_taxes (boolean|null), created_at (string:date-time|null), currency (string), customer_email (string:email), domain (string|null), eligible_for_payments (boolean), email (string:email), enabled_presentment_currencies (array<string>), finances (boolean), google_apps_domain (string:hostname|null), google_apps_login_enabled (boolean|null), has_discounts (boolean), has_gift_cards (boolean), has_storefront (boolean), iana_timezone (string|null), id (integer), latitude (number|null), longitude (number|null), marketing_sms_consent_enabled_at_checkout (boolean), money_format (string), money_in_emails_format (string), money_with_currency_format (string), money_with_currency_in_emails_format (string), multi_location_enabled (boolean), myshopify_domain (string|null), name (string), password_enabled (boolean|null), phone (string), plan_display_name (string), plan_name (string), pre_launch_enabled (boolean), primary_locale (string), primary_location_id (integer), province (string), province_code (string|null), requires_extra_payments_agreement (boolean), setup_required (boolean), shop_owner (string), source (string|null), tax_shipping (boolean|null), taxes_included (boolean|null), timezone (string), transactional_sms_disabled (boolean), updated_at (string:date-time|null), weight_unit (string), zip (string)

### subscription_billing_attempts

- **subscription_billing_attempts/challenged** — Occurs when the financial instutition challenges the subscripttion billing attempt charge as per 3D Secure.
  fields: (no fields)
- **subscription_billing_attempts/failure** — Occurs whenever a subscription billing attempt fails.
  fields: (no fields)
- **subscription_billing_attempts/success** — Occurs whenever a subscription billing attempt succeeds.
  fields: (no fields)

### subscription_billing_cycle_edits

- **subscription_billing_cycle_edits/create** — Occurs whenever a subscription contract billing cycle is edited.
  fields: billing_attempt_expected_date (string:date-time), contract_edit (string|null), cycle_end_at (string:date-time), cycle_index (integer), cycle_start_at (string:date-time), edited (boolean), skipped (boolean), subscription_contract_id (integer)
- **subscription_billing_cycle_edits/delete** — Occurs whenever a subscription contract billing cycle edit is deleted.
  fields: billing_attempt_expected_date (string:date-time), contract_edit (string|null), cycle_end_at (string:date-time), cycle_index (integer), cycle_start_at (string:date-time), edited (boolean), skipped (boolean), subscription_contract_id (integer)
- **subscription_billing_cycle_edits/update** — Occurs whenever a subscription contract billing cycle edit is updated.
  fields: billing_attempt_expected_date (string:date-time), contract_edit (string|null), cycle_end_at (string:date-time), cycle_index (integer), cycle_start_at (string:date-time), edited (boolean), skipped (boolean), subscription_contract_id (integer)

### subscription_billing_cycles

- **subscription_billing_cycles/skip** — Occurs whenever a subscription contract billing cycle is skipped.
  fields: billing_attempt_expected_date (string:date-time), contract_edit (string|null), cycle_end_at (string:date-time), cycle_index (integer), cycle_start_at (string:date-time), edited (boolean), skipped (boolean), subscription_contract_id (integer)
- **subscription_billing_cycles/unskip** — Occurs whenever a subscription contract billing cycle is unskipped.
  fields: billing_attempt_expected_date (string:date-time), contract_edit (string|null), cycle_end_at (string:date-time), cycle_index (integer), cycle_start_at (string:date-time), edited (boolean), skipped (boolean), subscription_contract_id (integer)

### subscription_contracts

- **subscription_contracts/activate** — Occurs when a subscription contract is activated.
  fields: admin_graphql_api_customer_id (string:uri), admin_graphql_api_id (string:uri), admin_graphql_api_origin_order_id (string:uri), billing_policy (object), currency_code (string), customer_id (integer), delivery_policy (object), id (integer), origin_order_id (integer), revision_id (string), status (string)
- **subscription_contracts/cancel** — Occurs when a subscription contract is canceled.
  fields: admin_graphql_api_customer_id (string:uri), admin_graphql_api_id (string:uri), admin_graphql_api_origin_order_id (string:uri), billing_policy (object), currency_code (string), customer_id (integer), delivery_policy (object), id (integer), origin_order_id (integer), revision_id (string), status (string)
- **subscription_contracts/create** — Occurs whenever a subscription contract is created.
  fields: admin_graphql_api_customer_id (string:uri), admin_graphql_api_id (string:uri), admin_graphql_api_origin_order_id (string:uri), billing_policy (object), currency_code (string), customer_id (integer), delivery_policy (object), id (integer), origin_order_id (integer), revision_id (string), status (string)
- **subscription_contracts/expire** — Occurs when a subscription contract expires.
  fields: admin_graphql_api_customer_id (string:uri), admin_graphql_api_id (string:uri), admin_graphql_api_origin_order_id (string:uri), billing_policy (object), currency_code (string), customer_id (integer), delivery_policy (object), id (integer), origin_order_id (integer), revision_id (string), status (string)
- **subscription_contracts/fail** — Occurs when a subscription contract is failed.
  fields: admin_graphql_api_customer_id (string:uri), admin_graphql_api_id (string:uri), admin_graphql_api_origin_order_id (string:uri), billing_policy (object), currency_code (string), customer_id (integer), delivery_policy (object), id (integer), origin_order_id (integer), revision_id (string), status (string)
- **subscription_contracts/pause** — Occurs when a subscription contract is paused.
  fields: admin_graphql_api_customer_id (string:uri), admin_graphql_api_id (string:uri), admin_graphql_api_origin_order_id (string:uri), billing_policy (object), currency_code (string), customer_id (integer), delivery_policy (object), id (integer), origin_order_id (integer), revision_id (string), status (string)
- **subscription_contracts/update** — Occurs whenever a subscription contract is updated.
  fields: admin_graphql_api_customer_id (string:uri), admin_graphql_api_id (string:uri), admin_graphql_api_origin_order_id (string:uri), billing_policy (object), currency_code (string), customer_id (integer), delivery_policy (object), id (integer), origin_order_id (integer), revision_id (string), status (string)

### tax_services

- **tax_services/create** — Occurs whenever a tax service is created.
  fields: active (boolean), id (null), name (string), url (string:uri)
- **tax_services/update** — Occurs whenver a tax service is updated.
  fields: active (boolean), id (null), name (string), url (string:uri)

### tender_transactions

- **tender_transactions/create** — Occurs when a tender transaction is created.
  fields: amount (string), currency (string), id (integer), order_id (integer), payment_details (object|null), payment_method (string), processed_at (string:date-time|null), remote_reference (string), test (boolean), user_id (integer|null)

### themes

- **themes/create** — Occurs whenever a theme is created. Does not occur when theme files are created.
  fields: admin_graphql_api_id (string:uri), created_at (string:date-time), id (integer), name (string), previewable (boolean), processing (boolean), role (string), theme_store_id (integer|null), updated_at (string:date-time)
- **themes/delete** — Occurs whenever a theme is deleted. Does not occur when theme files are deleted.
  fields: id (integer)
- **themes/publish** — Occurs whenever a theme with the main or mobile (deprecated) role is published.
  fields: admin_graphql_api_id (string:uri), created_at (string:date-time), id (integer), name (string), previewable (boolean), processing (boolean), role (string), theme_store_id (integer|null), updated_at (string:date-time)
- **themes/update** — Occurs whenever a theme is updated. Does not occur when theme files are updated.
  fields: admin_graphql_api_id (string:uri), created_at (string:date-time), id (integer), name (string), previewable (boolean), processing (boolean), role (string), theme_store_id (integer|null), updated_at (string:date-time)

### variants

- **variants/in_stock** — Occurs whenever a variant becomes in stock. Online channels receive this webhook only when the variant becomes in stock online.
  fields: admin_graphql_api_id (string:uri), barcode (null), compare_at_price (string), created_at (string:date-time), id (integer), image_id (null), inventory_policy (string), inventory_quantity (integer), old_inventory_quantity (integer), option1 (string), option2 (null), option3 (null), position (integer), price (string), product_id (integer), sku (null), taxable (boolean), title (string), updated_at (string:date-time)
- **variants/out_of_stock** — Occurs whenever a variant becomes out of stock. Online channels receive this webhook only when the variant becomes out of stock online.
  fields: admin_graphql_api_id (string:uri), barcode (null), compare_at_price (string), created_at (string:date-time), id (integer), image_id (null), inventory_policy (string), inventory_quantity (integer), old_inventory_quantity (integer), option1 (string), option2 (null), option3 (null), position (integer), price (string), product_id (integer), sku (null), taxable (boolean), title (string), updated_at (string:date-time)
