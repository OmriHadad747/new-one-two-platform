## Shopify webhook topics — version 2026-04

_(catalog pinned to gadget-inc/shopify-webhook-schemas@ac21e6a)_

Each entry shows the webhook's topic string, what triggers it, and the fields its payload actually delivers. The trigger's HLD `signalFields` should map onto these fields; if a needed value isn't here, the LLD must derive it from a Shopify lookup.

### app

- **app/scopes_update** — Occurs whenever the access scopes of any installation are modified. Allows apps to keep track of the granted access scopes of their installations.
- **app/uninstalled** — Occurs whenever a shop has uninstalled the app.

### app_purchases_one_time

- **app_purchases_one_time/update** — Occurs whenever a one-time app charge is updated.

### app_subscriptions

- **app_subscriptions/approaching_capped_amount** — Occurs when the balance used on an app subscription crosses 90% of the capped amount.
- **app_subscriptions/update** — Occurs whenever an app subscription is updated.

### audit_events

- **audit_events/admin_api_activity** — Triggers for each auditable Admin API request. This topic is limited to one active subscription per Plus store and requires the use of Google Cloud Pub/Sub or AWS EventBridge.

### bulk_operations

- **bulk_operations/finish** — Notifies when a Bulk Operation finishes.

### carts

- **carts/create** — Occurs when a cart is created in the online store. Other types of carts aren't supported. For example, the webhook doesn't support carts that are created in a custom storefront.
- **carts/update** — Occurs when a cart is updated in the online store. Other types of carts aren't supported. For example, the webhook doesn't support carts that are updated in a custom storefront.

### channels

- **channels/delete** — Occurs whenever a channel is deleted.

### checkouts

- **checkouts/create** — Occurs whenever a checkout is created.
- **checkouts/delete** — Occurs whenever a checkout is deleted.
- **checkouts/update** — Occurs whenever a checkout is updated.

### collection_listings

- **collection_listings/add** — Occurs whenever a collection listing is added.
- **collection_listings/remove** — Occurs whenever a collection listing is removed.
- **collection_listings/update** — Occurs whenever a collection listing is updated.

### collection_publications

- **collection_publications/create** — Occurs whenever a collection publication listing is created.
- **collection_publications/delete** — Occurs whenever a collection publication listing is deleted.
- **collection_publications/update** — Occurs whenever a collection publication listing is updated.

### collections

- **collections/create** — Occurs whenever a collection is created.
- **collections/delete** — Occurs whenever a collection is deleted.
- **collections/update** — Occurs whenever a collection is updated, including when a product is manually added or removed from the collection or when the collection rules change. Occurs once if multiple products are manually added or removed from a collection at the same time. Not fired when attribute changes affect whether a product matches a collection's rules.

### companies

- **companies/create** — Occurs whenever a company is created.
- **companies/delete** — Occurs whenever a company is deleted.
- **companies/update** — Occurs whenever a company is updated.

### company_contact_roles

- **company_contact_roles/assign** — Occurs whenever a role is assigned to a contact at a location.
- **company_contact_roles/revoke** — Occurs whenever a role is revoked from a contact at a location.

### company_contacts

- **company_contacts/create** — Occurs whenever a company contact is created.
- **company_contacts/delete** — Occurs whenever a company contact is deleted.
- **company_contacts/update** — Occurs whenever a company contact is updated.

### company_locations

- **company_locations/create** — Occurs whenever a company location is created.
- **company_locations/delete** — Occurs whenever a company location is deleted.
- **company_locations/update** — Occurs whenever a company location is updated.

### customer.joined_segment

- **customer.joined_segment** — Triggers when a customer joins a segment.

### customer.left_segment

- **customer.left_segment** — Triggers when a customer leaves a segment.

### customer.tags_added

- **customer.tags_added** — Triggers when tags are added to a customer.

### customer.tags_removed

- **customer.tags_removed** — Triggers when tags are removed from a customer.

### customer_account_settings

- **customer_account_settings/update** — Triggers when merchants change customer account setting.

### customer_groups

- **customer_groups/create** — Occurs whenever a customer saved search is created.
- **customer_groups/delete** — Occurs whenever a customer saved search is deleted.
- **customer_groups/update** — Occurs whenever a customer saved search is updated.

### customer_payment_methods

- **customer_payment_methods/create** — Occurs whenever a customer payment method is created.
- **customer_payment_methods/revoke** — Occurs whenever a customer payment method is revoked.
- **customer_payment_methods/update** — Occurs whenever a customer payment method is updated.

### customers

- **customers/create** — Occurs whenever a customer is created.
- **customers/data_request** — Customers can request their data from a store owner. When this happens, Shopify sends a payload on the customers/data_request topic to the apps that are installed on that store.
- **customers/delete** — Occurs whenever a customer is deleted.
- **customers/disable** — Occurs whenever a customer account is disabled.
- **customers/enable** — Occurs whenever a customer account is enabled.
- **customers/merge** — Triggers when two customers are merged
- **customers/purchasing_summary** — Occurs when a customer sales history change.
- **customers/redact** — Store owners can request that data is deleted on behalf of a customer. When this happens, Shopify sends a payload on the customers/redact topic to the apps installed on that store.

Customer redaction occurs either at the end of the grace period after the redaction was requested (today + 10 days), OR the customer's last order date plus the chargeback period of 60 days (last order date + 60 days), whichever occurs later.
- **customers/update** — Occurs whenever a customer is updated.

### customers_email_marketing_consent

- **customers_email_marketing_consent/update** — Occurs whenever a customer's email marketing consent is updated.

### customers_marketing_consent

- **customers_marketing_consent/update** — Occurs whenever a customer's SMS marketing consent is updated.

### delivery_promise_settings

- **delivery_promise_settings/update** — Occurs when a promise setting is updated.

### discounts

- **discounts/create** — Occurs whenever a discount is created.
- **discounts/delete** — Occurs whenever a discount is deleted.
- **discounts/redeemcode_added** — Occurs whenever a redeem code is added to a code discount.
- **discounts/redeemcode_removed** — Occurs whenever a redeem code on a code discount is deleted.
- **discounts/update** — Occurs whenever a discount is updated.

### disputes

- **disputes/create** — Occurs whenever a dispute is created.
- **disputes/update** — Occurs whenever a dispute is updated.

### domains

- **domains/create** — Occurs whenever a domain is created.
- **domains/destroy** — Occurs whenever a domain is destroyed.
- **domains/update** — Occurs whenever a domain is updated.

### draft_orders

- **draft_orders/create** — Occurs whenever a draft order is created.
- **draft_orders/delete** — Occurs whenever a draft order is deleted.
- **draft_orders/update** — Occurs whenever a draft order is updated.

### finance_app_staff_member

- **finance_app_staff_member/delete** — Triggers when a staff with access to all or some finance app has been removed.
- **finance_app_staff_member/grant** — Triggers when a staff is granted access to all or some finance app.
- **finance_app_staff_member/revoke** — Triggers when a staff's access to all or some finance app has been revoked.
- **finance_app_staff_member/update** — Triggers when a staff's information has been updated.

### finance_kyc_information

- **finance_kyc_information/update** — Occurs whenever shop's finance KYC information was updated

### fulfillment_events

- **fulfillment_events/create** — Occurs whenever a fulfillment event is created.
- **fulfillment_events/delete** — Occurs whenever a fulfillment event is deleted.

### fulfillment_holds

- **fulfillment_holds/added** — Occurs each time that a hold is added to a fulfillment order.

For cases where multiple holds are applied to a fulfillment order, this webhook will trigger after each hold is applied.
- **fulfillment_holds/released** — Occurs each time that a hold is released from a fulfillment order.
For cases where multiple holds are released from a fulfillment order a the same time, this webhook will trigger for each released hold.

### fulfillment_orders

- **fulfillment_orders/cancellation_request_accepted** — Occurs when a 3PL accepts a fulfillment cancellation request, received from a merchant.
- **fulfillment_orders/cancellation_request_rejected** — Occurs when a 3PL rejects a fulfillment cancellation request, received from a merchant.
- **fulfillment_orders/cancellation_request_submitted** — Occurs when a merchant requests a fulfillment request to be cancelled after that request was approved by a 3PL.
- **fulfillment_orders/cancelled** — Occurs when a fulfillment order is cancelled.
- **fulfillment_orders/fulfillment_request_accepted** — Occurs when a fulfillment service accepts a request to fulfill a fulfillment order.
- **fulfillment_orders/fulfillment_request_rejected** — Occurs when a 3PL rejects a fulfillment request that was sent by a merchant.
- **fulfillment_orders/fulfillment_request_submitted** — Occurs when a merchant submits a fulfillment request to a 3PL.
- **fulfillment_orders/fulfillment_service_failed_to_complete** — Occurs when a fulfillment service intends to close an in_progress fulfillment order.
- **fulfillment_orders/hold_released** — Occurs when a fulfillment order is released and is no longer on hold.

If a fulfillment order has multiple holds then this webhook will only be triggered once when the last hold is released and the status of the fulfillment order is no longer `ON_HOLD`.
- **fulfillment_orders/line_items_prepared_for_local_delivery** — Occurs whenever a fulfillment order's line items are prepared for local delivery.
- **fulfillment_orders/line_items_prepared_for_pickup** — Triggers when one or more of the line items for a fulfillment order are prepared for pickup
- **fulfillment_orders/manually_reported_progress_stopped** — Occurs when a fulfillment order that has previously been manually marked as in progress is marked back as open.
- **fulfillment_orders/merged** — Occurs when multiple fulfillment orders are merged into a single fulfillment order.
- **fulfillment_orders/moved** — Occurs whenever the location which is assigned to fulfill one or more fulfillment order line items is changed.

* `original_fulfillment_order` - The final state of the original fulfillment order.
* `moved_fulfillment_order` - The fulfillment order which now contains the re-assigned line items.
* `source_location` - The original location which was assigned to fulfill the line items (available as of the `2023-04` API version).
* `destination_location_id` - The ID of the location which is now responsible for fulfilling the line items.

**Note:** The [assignedLocation](https://shopify.dev/docs/api/admin-graphql/latest/objects/fulfillmentorder#field-fulfillmentorder-assignedlocation)
of the `original_fulfillment_order` might be changed by the move operation.
If you need to determine the originally assigned location, then you should refer to the `source_location`.

[Learn more about moving line items](https://shopify.dev/docs/api/admin-graphql/latest/mutations/fulfillmentOrderMove).
- **fulfillment_orders/order_routing_complete** — Occurs when an order has finished being routed and it's fulfillment orders assigned to a fulfillment service's location.
- **fulfillment_orders/placed_on_hold** — Occurs when a fulfillment order transitions to the `ON_HOLD` status

For cases where multiple holds are applied to a fulfillment order, this webhook will only trigger once when the first hold is applied and the fulfillment order status changes to `ON_HOLD`.
- **fulfillment_orders/progress_reported** — Occurs when progress is reported for a fulfillment order.
- **fulfillment_orders/rescheduled** — Triggers when a fulfillment order is rescheduled.

Fulfillment orders may be merged if they have the same `fulfillAt` datetime.
If the fulfillment order is merged then the resulting fulfillment order will be indicated in the webhook body.
Otherwise it will be the original fulfillment order with an updated `fulfill_at` datetime.
- **fulfillment_orders/scheduled_fulfillment_order_ready** — Occurs whenever a fulfillment order which was scheduled becomes due.
- **fulfillment_orders/split** — Occurs when a fulfillment order is split into multiple fulfillment orders.

### fulfillments

- **fulfillments/create** — Occurs whenever a fulfillment is created.
- **fulfillments/update** — Occurs whenever a fulfillment is updated.

### inventory_items

- **inventory_items/create** — Occurs whenever an inventory item is created.
- **inventory_items/delete** — Occurs whenever an inventory item is deleted.
- **inventory_items/update** — Occurs whenever an inventory item is updated.

### inventory_levels

- **inventory_levels/connect** — Occurs whenever an inventory level is connected.
- **inventory_levels/disconnect** — Occurs whenever an inventory level is disconnected.
- **inventory_levels/update** — Occurs whenever an inventory level is updated.

### inventory_shipments

- **inventory_shipments/add_items** — Occurs whenever items are added to a shipment.
- **inventory_shipments/create** — Triggers when a shipment is created.
- **inventory_shipments/delete** — Triggers when a shipment is deleted.
- **inventory_shipments/mark_in_transit** — Triggers when a shipment is marked as in transit.
- **inventory_shipments/receive_items** — Triggers when items on a shipment are received.
- **inventory_shipments/remove_items** — Occurs whenever items are removed from a shipment.
- **inventory_shipments/update_item_quantities** — Occurs whenever quantities change on a shipment.
- **inventory_shipments/update_tracking** — Triggers when tracking info on a shipment is updated.

### inventory_transfers

- **inventory_transfers/add_items** — Occurs any time items are added to a transfer.
- **inventory_transfers/cancel** — Triggers when a transfer is canceled.
- **inventory_transfers/complete** — Triggers when a transfer is completed.
- **inventory_transfers/ready_to_ship** — Triggers when a transfer is marked as ready to ship.
- **inventory_transfers/remove_items** — Occurs any time items are removed from a transfer.
- **inventory_transfers/update_item_quantities** — Occurs whenever the quantity of transfer line items changes.

### locales

- **locales/create** — Occurs whenever a shop locale is created
- **locales/destroy** — Occurs whenever a shop locale is destroyed
- **locales/update** — Occurs whenever a shop locale is updated, such as published or unpublished

### locations

- **locations/activate** — Occurs whenever a deactivated location is re-activated.
- **locations/create** — Occurs whenever a location is created.
- **locations/deactivate** — Occurs whenever a location is deactivated.
- **locations/delete** — Occurs whenever a location is deleted.
- **locations/update** — Occurs whenever a location is updated.

### markets

- **markets/create** — Occurs when a new market is created.
- **markets/delete** — Occurs when a market is deleted.
- **markets/update** — Occurs when a market is updated.

### markets_backup_region

- **markets_backup_region/update** — Occurs when a backup region is updated.

### metafield_definitions

- **metafield_definitions/create** — Occurs when a metafield definition is created.
- **metafield_definitions/delete** — Occurs when a metafield definition is deleted.
- **metafield_definitions/update** — Occurs when a metafield definition is updated.

### metaobjects

- **metaobjects/create** — Occurs when a metaobject is created.
- **metaobjects/delete** — Occurs when a metaobject is deleted.
- **metaobjects/update** — Occurs when a metaobject is updated.

### order_transactions

- **order_transactions/create** — Occurs when a order transaction is created or when it's status is updated. Only occurs for transactions with a status of success, failure or error.

### orders

- **orders/cancelled** — Occurs whenever an order is cancelled.
- **orders/create** — Occurs whenever an order is created.
- **orders/delete** — Occurs whenever an order is deleted.
- **orders/edited** — Occurs whenever an order is edited.
- **orders/fulfilled** — Occurs whenever an order is fulfilled.
- **orders/link_requested** — Occurs whenever a customer requests a new order link from the expired order status page.
- **orders/paid** — Occurs whenever an order is paid.
- **orders/partially_fulfilled** — Occurs whenever an order is partially fulfilled.
- **orders/risk_assessment_changed** — Triggers when a new risk assessment is available on the order.
This can be the first or a subsequent risk assessment.
New risk assessments can be provided until the order is marked as fulfilled.
Includes the risk level, risk facts, the provider and the order ID.
When the provider is Shopify, that field is null.
Does not include the risk recommendation for the order.
The Shop ID is available in the headers.
- **orders/shopify_protect_eligibility_changed** — Occurs whenever Shopify Protect's eligibility for an order is changed.
- **orders/updated** — Occurs whenever an order is updated.

### payment_schedules

- **payment_schedules/due** — Occurs whenever payment schedules are due.

### payment_terms

- **payment_terms/create** — Occurs whenever payment terms are created.
- **payment_terms/delete** — Occurs whenever payment terms are deleted.
- **payment_terms/update** — Occurs whenever payment terms are updated.

### product_feeds

- **product_feeds/create** — Triggers when product feed is created
- **product_feeds/full_sync** — Triggers when a full sync for a product feed is performed
- **product_feeds/full_sync_finish** — Triggers when a full sync finishes
- **product_feeds/incremental_sync** — Occurs whenever a product publication is created, updated or removed for a product feed
- **product_feeds/update** — Triggers when product feed is updated

### product_listings

- **product_listings/add** — Occurs whenever an active product is listed on a channel.
- **product_listings/remove** — Occurs whenever a product listing is removed from the channel.
- **product_listings/update** — Occurs whenever a product publication is updated.

### product_publications

- **product_publications/create** — Occurs whenever a product publication for an active product is created, or whenever an existing product publication is published on the app that is subscribed to this webhook topic. Note that a webhook is only emitted when there are publishing changes to the app that is subscribed to the topic (ie. no webhook will be emitted if there is a publishing change to the online store and the webhook subscriber of the topic is a third-party app).
- **product_publications/delete** — Occurs whenever a product publication for an active product is removed, or whenever an existing product publication is unpublished from the app that is subscribed to this webhook topic. Note that a webhook is only emitted when there are publishing changes to the app that is subscribed to the topic (ie. no webhook will be emitted if there is a publishing change to the online store and the webhook subscriber of the topic is a third-party app).
- **product_publications/update** — Occurs whenever a product publication is updated from the app that is subscribed to this webhook topic. Note that a webhook is only emitted when there are publishing changes to the app that is subscribed to the topic (ie. no webhook will be emitted if there is a publishing change to the online store and the webhook subscriber of the topic is a third-party app).

### products

- **products/create** — Occurs whenever a product is created. Product webhooks will return a full variants payload for the first 100 records. For records 101 and higher, the payload won't include the full variant details, but the `variant_gids` field will still include a `admin_graphql_api_id` value for these variants. `variant_gids` are sorted by `updated_at`, with the gids for recently updated variants appearing first.
- **products/delete** — Occurs whenever a product is deleted.
- **products/update** — Occurs whenever a product is updated, ordered, or variants are added, removed or updated. Product webhooks will return a full variants payload for the first 100 records. For records 101 and higher, the payload won't include the full variant details, but the `variant_gids` field will still include a `admin_graphql_api_id` value for these variants. `variant_gids` are sorted by `updated_at`, with the gids for recently updated variants appearing first.

### profiles

- **profiles/create** — Occurs whenever a delivery profile is created
- **profiles/delete** — Occurs whenever a delivery profile is deleted
- **profiles/update** — Occurs whenever a delivery profile is updated

### refunds

- **refunds/create** — Occurs whenever a new refund is created without errors on an order, independent from the movement of money.

### returns

- **returns/approve** — Occurs whenever a return is approved. This means `Return.status` is `OPEN`.
- **returns/cancel** — Occurs whenever a return is canceled.
- **returns/close** — Occurs whenever a return is closed.
- **returns/decline** — Occurs whenever a return is declined. This means `Return.status` is `DECLINED`.
- **returns/process** — Occurs whenever a return is processed.
- **returns/reopen** — Occurs whenever a closed return is reopened.
- **returns/request** — Occurs whenever a return is requested. This means `Return.status` is `REQUESTED`.
- **returns/update** — Occurs whenever a return is updated.

### reverse_deliveries

- **reverse_deliveries/attach_deliverable** — Occurs whenever a deliverable is attached to a reverse delivery.
This occurs when a reverse delivery is created or updated with delivery metadata.
Metadata includes the delivery method, label, and tracking information associated with a reverse delivery.

### reverse_fulfillment_orders

- **reverse_fulfillment_orders/dispose** — Occurs whenever a disposition is made on a reverse fulfillment order.
This includes dispositions made on reverse deliveries that are associated with the reverse fulfillment order.

### scheduled_product_listings

- **scheduled_product_listings/add** — Occurs whenever a product is scheduled to be published.
- **scheduled_product_listings/remove** — Occurs whenever a product is no longer scheduled to be published.
- **scheduled_product_listings/update** — Occurs whenever a product's scheduled availability date changes.

### segments

- **segments/create** — Occurs whenever a segment is created.
- **segments/delete** — Occurs whenever a segment is deleted.
- **segments/update** — Occurs whenever a segment is updated.

### selling_plan_groups

- **selling_plan_groups/create** — Notifies when a SellingPlanGroup is created.
- **selling_plan_groups/delete** — Notifies when a SellingPlanGroup is deleted.
- **selling_plan_groups/update** — Notifies when a SellingPlanGroup is updated.

### shipping_addresses

- **shipping_addresses/create** — Occurs whenever a shipping address is created.
- **shipping_addresses/update** — Occurs whenever a shipping address is updated.

### shop

- **shop/redact** — 48 hours after a store owner uninstalls your app, Shopify sends a payload on the shop/redact topic. This webhook provides the store's shop_id and shop_domain so that you can erase data for that store from your database.

While testing with this topic in development, note that the corresponding event on your test shop will not result in a webhook triggering immediately. shop/redact webhooks are emitted no earlier than 48 hours after uninstalling the app, and they do not fire if the app has been re-installed again.
- **shop/update** — Occurs whenever a shop is updated.

### subscription_billing_attempts

- **subscription_billing_attempts/challenged** — Occurs when the financial instutition challenges the subscripttion billing attempt charge as per 3D Secure.
- **subscription_billing_attempts/failure** — Occurs whenever a subscription billing attempt fails.
- **subscription_billing_attempts/success** — Occurs whenever a subscription billing attempt succeeds.

### subscription_billing_cycle_edits

- **subscription_billing_cycle_edits/create** — Occurs whenever a subscription contract billing cycle is edited.
- **subscription_billing_cycle_edits/delete** — Occurs whenever a subscription contract billing cycle edit is deleted.
- **subscription_billing_cycle_edits/update** — Occurs whenever a subscription contract billing cycle edit is updated.

### subscription_billing_cycles

- **subscription_billing_cycles/skip** — Occurs whenever a subscription contract billing cycle is skipped.
- **subscription_billing_cycles/unskip** — Occurs whenever a subscription contract billing cycle is unskipped.

### subscription_contracts

- **subscription_contracts/activate** — Occurs when a subscription contract is activated.
- **subscription_contracts/cancel** — Occurs when a subscription contract is canceled.
- **subscription_contracts/create** — Occurs whenever a subscription contract is created.
- **subscription_contracts/expire** — Occurs when a subscription contract expires.
- **subscription_contracts/fail** — Occurs when a subscription contract is failed.
- **subscription_contracts/pause** — Occurs when a subscription contract is paused.
- **subscription_contracts/update** — Occurs whenever a subscription contract is updated.

### tax_services

- **tax_services/create** — Occurs whenever a tax service is created.
- **tax_services/update** — Occurs whenver a tax service is updated.

### tender_transactions

- **tender_transactions/create** — Occurs when a tender transaction is created.

### themes

- **themes/create** — Occurs whenever a theme is created. Does not occur when theme files are created.
- **themes/delete** — Occurs whenever a theme is deleted. Does not occur when theme files are deleted.
- **themes/publish** — Occurs whenever a theme with the main or mobile (deprecated) role is published.
- **themes/update** — Occurs whenever a theme is updated. Does not occur when theme files are updated.

### variants

- **variants/in_stock** — Occurs whenever a variant becomes in stock. Online channels receive this webhook only when the variant becomes in stock online.
- **variants/out_of_stock** — Occurs whenever a variant becomes out of stock. Online channels receive this webhook only when the variant becomes out of stock online.
