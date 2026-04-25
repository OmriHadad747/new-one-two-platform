# Shopify Storefront GraphQL — 2026-04

Operation index for handler-prompt injection. Pick from the operations below — anything not listed is not in the schema and will fail offline validation. Full SDL with field-level shapes lives at catalogs/shopify_storefront/2026-04/schema.graphql.

## Queries — 30 ops

article(id: ID!): Article
articles(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: ArticleSortKeys, query: String): ArticleConnection!
blog(handle: String, id: ID): Blog
blogs(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: BlogSortKeys, query: String): BlogConnection!
cart(id: ID!): Cart
cartCompletionAttempt(attemptId: String!): CartCompletionAttemptResult
collection(id: ID, handle: String): Collection
collections(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: CollectionSortKeys, query: String): CollectionConnection!
customer(customerAccessToken: String!): Customer
localization: Localization!
locations(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: LocationSortKeys, near: GeoCoordinateInput): LocationConnection!
menu(handle: String!): Menu
metaobject(id: ID, handle: MetaobjectHandleInput): Metaobject
metaobjects(type: String!, sortKey: String, first: Int, after: String, last: Int, before: String, reverse: Boolean): MetaobjectConnection!
node(id: ID!): Node
nodes(ids: [ID!]!): [Node]!
page(handle: String, id: ID): Page
pages(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: PageSortKeys, query: String): PageConnection!
paymentSettings: PaymentSettings!
predictiveSearch(limit: Int, limitScope: PredictiveSearchLimitScope, query: String!, searchableFields: [SearchableField!], types: [PredictiveSearchType!], unavailableProducts: SearchUnavailableProductsType): PredictiveSearchResult
product(id: ID, handle: String): Product
productRecommendations(productId: ID, productHandle: String, intent: ProductRecommendationIntent): [Product!]
productTags(first: Int!): StringConnection!
productTypes(first: Int!): StringConnection!
products(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: ProductSortKeys, query: String): ProductConnection!
publicApiVersions: [ApiVersion!]!
search(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: SearchSortKeys, query: String!, prefix: SearchPrefixQueryType, productFilters: [ProductFilter!], types: [SearchType!], unavailableProducts: SearchUnavailableProductsType): SearchResultItemConnection!
shop: Shop!
sitemap(type: SitemapType!): Sitemap!
urlRedirects(first: Int, after: String, last: Int, before: String, reverse: Boolean, query: String): UrlRedirectConnection!

## Mutations — 41 ops

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
shopPayPaymentRequestSessionCreate(sourceIdentifier: String!, paymentRequest: ShopPayPaymentRequestInput!): ShopPayPaymentRequestSessionCreatePayload
shopPayPaymentRequestSessionSubmit(token: String!, paymentRequest: ShopPayPaymentRequestInput!, idempotencyKey: String!, orderName: String): ShopPayPaymentRequestSessionSubmitPayload
