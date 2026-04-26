# Shopify Storefront GraphQL — 2026-04

Operation index for handler-prompt injection. Pick from the operations below — anything not listed is not in the schema and will fail offline validation. Full SDL with field-level shapes lives at catalogs/shopify_storefront/2026-04/schema.graphql.

Operations are grouped by leading-noun resource cluster so the architect
can scan by topic. Within each cluster, ops are alphabetical. Singular and
plural roots (e.g. `order` vs `orders`) appear as adjacent clusters.

## Table of Contents

Queries — 30 ops in 26 clusters:
- article (1)
- articles (1)
- blog (1)
- blogs (1)
- cart (2)
- collection (1)
- collections (1)
- customer (1)
- localization (1)
- locations (1)
- menu (1)
- metaobject (1)
- metaobjects (1)
- node (1)
- nodes (1)
- page (1)
- pages (1)
- payment (1)
- predictive (1)
- product (4)
- products (1)
- public (1)
- search (1)
- shop (1)
- sitemap (1)
- url (1)

Mutations — 41 ops in 3 clusters:
- cart (24)
- customer (15)
- shop (2)

## Queries — article (1 ops)

article(id: ID!): Article

## Queries — articles (1 ops)

articles(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: ArticleSortKeys, query: String): ArticleConnection!

## Queries — blog (1 ops)

blog(handle: String, id: ID): Blog

## Queries — blogs (1 ops)

blogs(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: BlogSortKeys, query: String): BlogConnection!

## Queries — cart (2 ops)

cart(id: ID!): Cart
cartCompletionAttempt(attemptId: String!): CartCompletionAttemptResult

## Queries — collection (1 ops)

collection(id: ID, handle: String): Collection

## Queries — collections (1 ops)

collections(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: CollectionSortKeys, query: String): CollectionConnection!

## Queries — customer (1 ops)

customer(customerAccessToken: String!): Customer

## Queries — localization (1 ops)

localization: Localization!

## Queries — locations (1 ops)

locations(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: LocationSortKeys, near: GeoCoordinateInput): LocationConnection!

## Queries — menu (1 ops)

menu(handle: String!): Menu

## Queries — metaobject (1 ops)

metaobject(id: ID, handle: MetaobjectHandleInput): Metaobject

## Queries — metaobjects (1 ops)

metaobjects(type: String!, sortKey: String, first: Int, after: String, last: Int, before: String, reverse: Boolean): MetaobjectConnection!

## Queries — node (1 ops)

node(id: ID!): Node

## Queries — nodes (1 ops)

nodes(ids: [ID!]!): [Node]!

## Queries — page (1 ops)

page(handle: String, id: ID): Page

## Queries — pages (1 ops)

pages(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: PageSortKeys, query: String): PageConnection!

## Queries — payment (1 ops)

paymentSettings: PaymentSettings!

## Queries — predictive (1 ops)

predictiveSearch(limit: Int, limitScope: PredictiveSearchLimitScope, query: String!, searchableFields: [SearchableField!], types: [PredictiveSearchType!], unavailableProducts: SearchUnavailableProductsType): PredictiveSearchResult

## Queries — product (4 ops)

product(id: ID, handle: String): Product
productRecommendations(productId: ID, productHandle: String, intent: ProductRecommendationIntent): [Product!]
productTags(first: Int!): StringConnection!
productTypes(first: Int!): StringConnection!

## Queries — products (1 ops)

products(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: ProductSortKeys, query: String): ProductConnection!

## Queries — public (1 ops)

publicApiVersions: [ApiVersion!]!

## Queries — search (1 ops)

search(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: SearchSortKeys, query: String!, prefix: SearchPrefixQueryType, productFilters: [ProductFilter!], types: [SearchType!], unavailableProducts: SearchUnavailableProductsType): SearchResultItemConnection!

## Queries — shop (1 ops)

shop: Shop!

## Queries — sitemap (1 ops)

sitemap(type: SitemapType!): Sitemap!

## Queries — url (1 ops)

urlRedirects(first: Int, after: String, last: Int, before: String, reverse: Boolean, query: String): UrlRedirectConnection!

## Mutations — cart (24 ops)

cartAttributesUpdate(attributes: [AttributeInput!]!, cartId: ID!): CartAttributesUpdatePayload
cartBillingAddressUpdate(cartId: ID!, billingAddress: MailingAddressInput): CartBillingAddressUpdatePayload
cartBuyerIdentityUpdate(cartId: ID!, buyerIdentity: CartBuyerIdentityInput!): CartBuyerIdentityUpdatePayload
cartClone(cartId: ID!): CartClonePayload
cartCreate(input: CartInput): CartCreatePayload
cartDeliveryAddressesAdd(cartId: ID!, addresses: [CartSelectableAddressInput!]!): CartDeliveryAddressesAddPayload
cartDeliveryAddressesRemove(cartId: ID!, addressIds: [ID!]!): CartDeliveryAddressesRemovePayload
cartDeliveryAddressesReplace(cartId: ID!, addresses: [CartSelectableAddressInput!]!): CartDeliveryAddressesReplacePayload
cartDeliveryAddressesUpdate(cartId: ID!, addresses: [CartSelectableAddressUpdateInput!]!): CartDeliveryAddressesUpdatePayload
cartDiscountCodesUpdate(cartId: ID!, discountCodes: [String!]!): CartDiscountCodesUpdatePayload
cartGiftCardCodesAdd(cartId: ID!, giftCardCodes: [String!]!): CartGiftCardCodesAddPayload
cartGiftCardCodesRemove(cartId: ID!, appliedGiftCardIds: [ID!]!): CartGiftCardCodesRemovePayload
cartGiftCardCodesUpdate(cartId: ID!, giftCardCodes: [String!]!): CartGiftCardCodesUpdatePayload
cartLinesAdd(cartId: ID!, lines: [CartLineInput!]!): CartLinesAddPayload
cartLinesRemove(cartId: ID!, lineIds: [ID!]!): CartLinesRemovePayload
cartLinesUpdate(cartId: ID!, lines: [CartLineUpdateInput!]!): CartLinesUpdatePayload
cartMetafieldDelete(input: CartMetafieldDeleteInput!): CartMetafieldDeletePayload
cartMetafieldsSet(metafields: [CartMetafieldsSetInput!]!): CartMetafieldsSetPayload
cartNoteUpdate(cartId: ID!, note: String!): CartNoteUpdatePayload
cartPaymentUpdate(cartId: ID!, payment: CartPaymentInput!): CartPaymentUpdatePayload
cartPrepareForCompletion(cartId: ID!): CartPrepareForCompletionPayload
cartRemovePersonalData(cartId: ID!): CartRemovePersonalDataPayload
cartSelectedDeliveryOptionsUpdate(cartId: ID!, selectedDeliveryOptions: [CartSelectedDeliveryOptionInput!]!): CartSelectedDeliveryOptionsUpdatePayload
cartSubmitForCompletion(cartId: ID!, attemptToken: String!): CartSubmitForCompletionPayload

## Mutations — customer (15 ops)

customerAccessTokenCreate(input: CustomerAccessTokenCreateInput!): CustomerAccessTokenCreatePayload
customerAccessTokenCreateWithMultipass(multipassToken: String!): CustomerAccessTokenCreateWithMultipassPayload
customerAccessTokenDelete(customerAccessToken: String!): CustomerAccessTokenDeletePayload
customerAccessTokenRenew(customerAccessToken: String!): CustomerAccessTokenRenewPayload
customerActivate(id: ID!, input: CustomerActivateInput!): CustomerActivatePayload
customerActivateByUrl(activationUrl: URL!, password: String!): CustomerActivateByUrlPayload
customerAddressCreate(customerAccessToken: String!, address: MailingAddressInput!): CustomerAddressCreatePayload
customerAddressDelete(id: ID!, customerAccessToken: String!): CustomerAddressDeletePayload
customerAddressUpdate(customerAccessToken: String!, id: ID!, address: MailingAddressInput!): CustomerAddressUpdatePayload
customerCreate(input: CustomerCreateInput!): CustomerCreatePayload
customerDefaultAddressUpdate(customerAccessToken: String!, addressId: ID!): CustomerDefaultAddressUpdatePayload
customerRecover(email: String!): CustomerRecoverPayload
customerReset(id: ID!, input: CustomerResetInput!): CustomerResetPayload
customerResetByUrl(resetUrl: URL!, password: String!): CustomerResetByUrlPayload
customerUpdate(customerAccessToken: String!, customer: CustomerUpdateInput!): CustomerUpdatePayload

## Mutations — shop (2 ops)

shopPayPaymentRequestSessionCreate(sourceIdentifier: String!, paymentRequest: ShopPayPaymentRequestInput!): ShopPayPaymentRequestSessionCreatePayload
shopPayPaymentRequestSessionSubmit(token: String!, paymentRequest: ShopPayPaymentRequestInput!, idempotencyKey: String!, orderName: String): ShopPayPaymentRequestSessionSubmitPayload
