# Shopify Admin GraphQL — 2026-04

Operation index for handler-prompt injection. Pick from the operations below — anything not listed is not in the schema and will fail offline validation. Full SDL with field-level shapes lives at catalogs/shopify_admin/2026-04/schema.graphql.

Operations are grouped by leading-noun resource cluster so the architect
can scan by topic. Within each cluster, ops are alphabetical. Singular and
plural roots (e.g. `order` vs `orders`) appear as adjacent clusters.

## Table of Contents

Queries — 268 ops in 98 clusters:
- abandoned (2)
- abandonment (2)
- app (8)
- article (3)
- articles (1)
- automatic (2)
- available (3)
- backup (1)
- blog (1)
- blogs (2)
- bulk (2)
- business (2)
- carrier (2)
- cart (1)
- cash (7)
- catalog (2)
- catalogs (2)
- channel (2)
- channels (1)
- checkout (2)
- code (3)
- collection (4)
- collections (2)
- comment (1)
- comments (1)
- companies (2)
- company (5)
- consent (2)
- current (2)
- customer (11)
- customers (2)
- delivery (7)
- discount (7)
- dispute (2)
- disputes (1)
- domain (1)
- draft (6)
- event (1)
- events (2)
- file (1)
- files (1)
- finance (2)
- fulfillment (7)
- gift (4)
- inventory (8)
- job (1)
- location (2)
- locations (3)
- market (4)
- marketing (4)
- markets (2)
- menu (1)
- menus (1)
- metafield (4)
- metaobject (5)
- metaobjects (1)
- mobile (2)
- node (1)
- nodes (1)
- online (1)
- order (5)
- orders (3)
- page (1)
- pages (2)
- payment (3)
- point (3)
- price (2)
- privacy (1)
- product (15)
- products (3)
- public (1)
- publication (1)
- publications (2)
- refund (1)
- return (3)
- returnable (2)
- reverse (2)
- script (2)
- segment (5)
- segments (2)
- selling (2)
- server (1)
- shop (5)
- shopify (3)
- shopifyql (1)
- staff (2)
- store (2)
- subscription (8)
- taxonomy (1)
- tender (1)
- theme (1)
- themes (1)
- translatable (3)
- url (5)
- validation (1)
- validations (1)
- web (2)
- webhook (3)

Mutations — 477 ops in 74 clusters:
- abandonment (1)
- app (8)
- article (3)
- backup (1)
- blog (3)
- bulk (4)
- carrier (3)
- cart (2)
- cash (5)
- catalog (4)
- channel (4)
- checkout (1)
- collection (8)
- combined (1)
- comment (4)
- companies (1)
- company (27)
- consent (1)
- customer (29)
- data (1)
- delegate (2)
- delivery (10)
- discount (30)
- dispute (1)
- draft (12)
- event (1)
- file (4)
- flow (2)
- fulfillment (29)
- gift (7)
- inventory (26)
- location (7)
- market (5)
- marketing (9)
- menu (3)
- metafield (6)
- metafields (2)
- metaobject (9)
- mobile (3)
- order (25)
- page (3)
- payment (8)
- point (5)
- price (7)
- privacy (1)
- product (26)
- pub (1)
- publication (3)
- publishable (2)
- quantity (3)
- refund (1)
- return (9)
- reverse (3)
- saved (3)
- script (3)
- segment (3)
- selling (7)
- server (2)
- shipping (3)
- shop (5)
- shopify (1)
- staged (1)
- store (2)
- storefront (2)
- subscription (33)
- tags (2)
- tax (2)
- theme (8)
- transaction (1)
- translations (2)
- url (9)
- validation (3)
- web (6)
- webhook (3)

## Queries — abandoned (2 ops)

abandonedCheckouts(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: AbandonedCheckoutSortKeys, query: String, savedSearchId: ID): AbandonedCheckoutConnection!
abandonedCheckoutsCount(query: String, savedSearchId: ID, limit: Int): Count

## Queries — abandonment (2 ops)

abandonment(id: ID!): Abandonment
abandonmentByAbandonedCheckoutId(abandonedCheckoutId: ID!): Abandonment

## Queries — app (8 ops)

app(id: ID): App
appByHandle(handle: String!): App
appByKey(apiKey: String!): App
appDiscountType(functionId: String!): AppDiscountType
appDiscountTypes: [AppDiscountType!]!
appDiscountTypesNodes(first: Int, after: String, last: Int, before: String, reverse: Boolean): AppDiscountTypeConnection!
appInstallation(id: ID): AppInstallation
appInstallations(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: AppInstallationSortKeys, category: AppInstallationCategory, privacy: AppInstallationPrivacy): AppInstallationConnection!

## Queries — article (3 ops)

article(id: ID!): Article
articleAuthors(first: Int, after: String, last: Int, before: String, reverse: Boolean): ArticleAuthorConnection!
articleTags(sort: ArticleTagSort, limit: Int!): [String!]!

## Queries — articles (1 ops)

articles(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: ArticleSortKeys, query: String): ArticleConnection!

## Queries — automatic (2 ops)

automaticDiscountNode(id: ID!): DiscountAutomaticNode
automaticDiscountSavedSearches(first: Int, after: String, last: Int, before: String, reverse: Boolean): SavedSearchConnection!

## Queries — available (3 ops)

availableBackupRegions: [MarketRegion!]!
availableCarrierServices: [DeliveryCarrierServiceAndLocations!]!
availableLocales: [Locale!]!

## Queries — backup (1 ops)

backupRegion: MarketRegion!

## Queries — blog (1 ops)

blog(id: ID!): Blog

## Queries — blogs (2 ops)

blogs(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: BlogSortKeys, query: String): BlogConnection!
blogsCount(query: String, limit: Int): Count

## Queries — bulk (2 ops)

bulkOperation(id: ID!): BulkOperation
bulkOperations(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: BulkOperationsSortKeys, query: String): BulkOperationConnection!

## Queries — business (2 ops)

businessEntities: [BusinessEntity!]!
businessEntity(id: ID): BusinessEntity

## Queries — carrier (2 ops)

carrierService(id: ID!): DeliveryCarrierService
carrierServices(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: CarrierServiceSortKeys, query: String): DeliveryCarrierServiceConnection!

## Queries — cart (1 ops)

cartTransforms(first: Int, after: String, last: Int, before: String, reverse: Boolean): CartTransformConnection!

## Queries — cash (7 ops)

cashDrawer(id: ID!): CashDrawer
cashDrawers(first: Int, after: String, last: Int, before: String, query: String): CashDrawerConnection!
cashManagementLocationSummary(locationId: ID!, startDate: Date!, endDate: Date!): CashManagementSummary!
cashManagementReasonCodes(first: Int, after: String, last: Int, before: String, reverse: Boolean): CashManagementReasonCodeConnection!
cashManagementShopSummary(currencyCode: CurrencyCode!, startDate: Date!, endDate: Date!): CashManagementSummary!
cashTrackingSession(id: ID!): CashTrackingSession
cashTrackingSessions(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: CashTrackingSessionsSortKeys, query: String): CashTrackingSessionConnection!

## Queries — catalog (2 ops)

catalog(id: ID!): Catalog
catalogOperations: [ResourceOperation!]!

## Queries — catalogs (2 ops)

catalogs(type: CatalogType, first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: CatalogSortKeys, query: String): CatalogConnection!
catalogsCount(type: CatalogType, query: String, limit: Int): Count

## Queries — channel (2 ops)

channel(id: ID!): Channel
channelByHandle(handle: String!): Channel

## Queries — channels (1 ops)

channels(first: Int, after: String, last: Int, before: String, reverse: Boolean): ChannelConnection!

## Queries — checkout (2 ops)

checkoutAndAccountsConfiguration(id: ID!): CheckoutAndAccountsConfiguration
checkoutAndAccountsConfigurations(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: CheckoutAndAccountsConfigurationsGraphQLSortKeys, query: String): CheckoutAndAccountsConfigurationConnection

## Queries — code (3 ops)

codeDiscountNode(id: ID!): DiscountCodeNode
codeDiscountNodeByCode(code: String!): DiscountCodeNode
codeDiscountSavedSearches(first: Int, after: String, last: Int, before: String, reverse: Boolean): SavedSearchConnection!

## Queries — collection (4 ops)

collection(id: ID!): Collection
collectionByIdentifier(identifier: CollectionIdentifierInput!): Collection
collectionRulesConditions: [CollectionRuleConditions!]!
collectionSavedSearches(first: Int, after: String, last: Int, before: String, reverse: Boolean): SavedSearchConnection!

## Queries — collections (2 ops)

collections(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: CollectionSortKeys, query: String, savedSearchId: ID): CollectionConnection!
collectionsCount(query: String, savedSearchId: ID, limit: Int): Count

## Queries — comment (1 ops)

comment(id: ID!): Comment

## Queries — comments (1 ops)

comments(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: CommentSortKeys, query: String): CommentConnection!

## Queries — companies (2 ops)

companies(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: CompanySortKeys, query: String): CompanyConnection!
companiesCount(limit: Int): Count

## Queries — company (5 ops)

company(id: ID!): Company
companyContact(id: ID!): CompanyContact
companyContactRole(id: ID!): CompanyContactRole
companyLocation(id: ID!): CompanyLocation
companyLocations(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: CompanyLocationSortKeys, query: String): CompanyLocationConnection!

## Queries — consent (2 ops)

consentPolicy(id: ID, countryCode: PrivacyCountryCode, regionCode: String, consentRequired: Boolean, dataSaleOptOutRequired: Boolean): [ConsentPolicy!]!
consentPolicyRegions: [ConsentPolicyRegion!]!

## Queries — current (2 ops)

currentAppInstallation: AppInstallation!
currentStaffMember: StaffMember

## Queries — customer (11 ops)

customer(id: ID!): Customer
customerAccountPage(id: ID!): CustomerAccountPage
customerAccountPages(first: Int, after: String, last: Int, before: String, reverse: Boolean): CustomerAccountPageConnection
customerByIdentifier(identifier: CustomerIdentifierInput!): Customer
customerMergeJobStatus(jobId: ID!): CustomerMergeRequest
customerMergePreview(customerOneId: ID!, customerTwoId: ID!, overrideFields: CustomerMergeOverrideFields): CustomerMergePreview!
customerPaymentMethod(id: ID!, showRevoked: Boolean): CustomerPaymentMethod
customerSavedSearches(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: CustomerSavedSearchSortKeys, query: String): SavedSearchConnection!
customerSegmentMembers(segmentId: ID, query: String, queryId: ID, timezone: String, reverse: Boolean, sortKey: String, first: Int, after: String, last: Int, before: String): CustomerSegmentMemberConnection!
customerSegmentMembersQuery(id: ID!): CustomerSegmentMembersQuery
customerSegmentMembership(segmentIds: [ID!]!, customerId: ID!): SegmentMembershipResponse!

## Queries — customers (2 ops)

customers(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: CustomerSortKeys, query: String): CustomerConnection!
customersCount(query: String, limit: Int): Count

## Queries — delivery (7 ops)

deliveryCustomization(id: ID!): DeliveryCustomization
deliveryCustomizations(first: Int, after: String, last: Int, before: String, reverse: Boolean, query: String): DeliveryCustomizationConnection!
deliveryProfile(id: ID!): DeliveryProfile
deliveryProfiles(merchantOwnedOnly: Boolean, first: Int, after: String, last: Int, before: String, reverse: Boolean): DeliveryProfileConnection!
deliveryPromiseParticipants(ownerIds: [ID!], brandedPromiseHandle: String!, first: Int, after: String, last: Int, before: String, reverse: Boolean): DeliveryPromiseParticipantConnection
deliveryPromiseProvider(locationId: ID!): DeliveryPromiseProvider
deliveryPromiseSettings: DeliveryPromiseSetting!

## Queries — discount (7 ops)

discountCodesCount(query: String, limit: Int): Count
discountNode(id: ID!): DiscountNode
discountNodes(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: DiscountSortKeys, query: String, savedSearchId: ID): DiscountNodeConnection!
discountNodesCount(query: String, savedSearchId: ID, limit: Int): Count
discountRedeemCodeBulkCreation(id: ID!): DiscountRedeemCodeBulkCreation
discountRedeemCodeSavedSearches(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: DiscountCodeSortKeys, query: String): SavedSearchConnection!
discountTags(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: DiscountTagSortKeys, query: String): StringConnection!

## Queries — dispute (2 ops)

dispute(id: ID!): ShopifyPaymentsDispute
disputeEvidence(id: ID!): ShopifyPaymentsDisputeEvidence

## Queries — disputes (1 ops)

disputes(first: Int, after: String, last: Int, before: String, reverse: Boolean, query: String): ShopifyPaymentsDisputeConnection!

## Queries — domain (1 ops)

domain(id: ID!): Domain

## Queries — draft (6 ops)

draftOrder(id: ID!): DraftOrder
draftOrderAvailableDeliveryOptions(input: DraftOrderAvailableDeliveryOptionsInput!, search: String, localPickupFrom: Int, localPickupCount: Int, sessionToken: String): DraftOrderAvailableDeliveryOptions!
draftOrderSavedSearches(first: Int, after: String, last: Int, before: String, reverse: Boolean): SavedSearchConnection!
draftOrderTag(id: ID!): DraftOrderTag
draftOrders(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: DraftOrderSortKeys, query: String, savedSearchId: ID): DraftOrderConnection!
draftOrdersCount(query: String, savedSearchId: ID, limit: Int): Count

## Queries — event (1 ops)

event(id: ID!): Event

## Queries — events (2 ops)

events(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: EventSortKeys, query: String): EventConnection
eventsCount(query: String): Count

## Queries — file (1 ops)

fileSavedSearches(first: Int, after: String, last: Int, before: String, reverse: Boolean): SavedSearchConnection!

## Queries — files (1 ops)

files(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: FileSortKeys, query: String, savedSearchId: ID): FileConnection!

## Queries — finance (2 ops)

financeAppAccessPolicy: FinanceAppAccessPolicy!
financeKycInformation: FinanceKycInformation

## Queries — fulfillment (7 ops)

assignedFulfillmentOrders(assignmentStatus: FulfillmentOrderAssignmentStatus, locationIds: [ID!], first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: FulfillmentOrderSortKeys): FulfillmentOrderConnection!
fulfillment(id: ID!): Fulfillment
fulfillmentConstraintRules: [FulfillmentConstraintRule!]!
fulfillmentOrder(id: ID!): FulfillmentOrder
fulfillmentOrders(includeClosed: Boolean, first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: FulfillmentOrderSortKeys, query: String): FulfillmentOrderConnection!
fulfillmentService(id: ID!): FulfillmentService
manualHoldsFulfillmentOrders(query: String, first: Int, after: String, last: Int, before: String, reverse: Boolean): FulfillmentOrderConnection!

## Queries — gift (4 ops)

giftCard(id: ID!): GiftCard
giftCardConfiguration: GiftCardConfiguration!
giftCards(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: GiftCardSortKeys, query: String, savedSearchId: ID): GiftCardConnection!
giftCardsCount(query: String, savedSearchId: ID, limit: Int): Count

## Queries — inventory (8 ops)

inventoryItem(id: ID!): InventoryItem
inventoryItems(first: Int, after: String, last: Int, before: String, reverse: Boolean, query: String): InventoryItemConnection!
inventoryLevel(id: ID!): InventoryLevel
inventoryProperties: InventoryProperties!
inventoryShipment(id: ID!): InventoryShipment
inventoryShipments(first: Int, after: String, last: Int, before: String, sortKey: InventoryShipmentSortKeys, query: String): InventoryShipmentConnection
inventoryTransfer(id: ID!): InventoryTransfer
inventoryTransfers(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: TransferSortKeys, query: String, savedSearchId: ID): InventoryTransferConnection!

## Queries — job (1 ops)

job(id: ID!): Job

## Queries — location (2 ops)

location(id: ID): Location
locationByIdentifier(identifier: LocationIdentifierInput!): Location

## Queries — locations (3 ops)

locations(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: LocationSortKeys, query: String, includeLegacy: Boolean, includeInactive: Boolean): LocationConnection!
locationsAvailableForDeliveryProfilesConnection(first: Int, after: String, last: Int, before: String, reverse: Boolean): LocationConnection!
locationsCount(query: String, limit: Int): Count

## Queries — market (4 ops)

market(id: ID!): Market
marketLocalizableResource(resourceId: ID!): MarketLocalizableResource
marketLocalizableResources(resourceType: MarketLocalizableResourceType!, first: Int, after: String, last: Int, before: String, reverse: Boolean): MarketLocalizableResourceConnection!
marketLocalizableResourcesByIds(resourceIds: [ID!]!, first: Int, after: String, last: Int, before: String, reverse: Boolean): MarketLocalizableResourceConnection!

## Queries — marketing (4 ops)

marketingActivities(marketingActivityIds: [ID!], remoteIds: [String!], utm: UTMInput, first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: MarketingActivitySortKeys, query: String, savedSearchId: ID): MarketingActivityConnection!
marketingActivity(id: ID!): MarketingActivity
marketingEvent(id: ID!): MarketingEvent
marketingEvents(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: MarketingEventSortKeys, query: String): MarketingEventConnection!

## Queries — markets (2 ops)

markets(type: MarketType, first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: MarketsSortKeys, query: String): MarketConnection!
marketsResolvedValues(buyerSignal: BuyerSignalInput!): MarketsResolvedValues!

## Queries — menu (1 ops)

menu(id: ID!): Menu

## Queries — menus (1 ops)

menus(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: MenuSortKeys, query: String): MenuConnection!

## Queries — metafield (4 ops)

metafieldDefinition(identifier: MetafieldDefinitionIdentifierInput): MetafieldDefinition
metafieldDefinitionTypes: [MetafieldDefinitionType!]!
metafieldDefinitions(key: String, namespace: String, ownerType: MetafieldOwnerType!, pinnedStatus: MetafieldDefinitionPinnedStatus, constraintSubtype: MetafieldDefinitionConstraintSubtypeIdentifier, constraintStatus: MetafieldDefinitionConstraintStatus, first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: MetafieldDefinitionSortKeys, query: String): MetafieldDefinitionConnection!
standardMetafieldDefinitionTemplates(constraintSubtype: MetafieldDefinitionConstraintSubtypeIdentifier, constraintStatus: MetafieldDefinitionConstraintStatus, excludeActivated: Boolean, first: Int, after: String, last: Int, before: String, reverse: Boolean): StandardMetafieldDefinitionTemplateConnection!

## Queries — metaobject (5 ops)

metaobject(id: ID!): Metaobject
metaobjectByHandle(handle: MetaobjectHandleInput!): Metaobject
metaobjectDefinition(id: ID!): MetaobjectDefinition
metaobjectDefinitionByType(type: String!): MetaobjectDefinition
metaobjectDefinitions(first: Int, after: String, last: Int, before: String, reverse: Boolean): MetaobjectDefinitionConnection!

## Queries — metaobjects (1 ops)

metaobjects(type: String!, sortKey: String, first: Int, after: String, last: Int, before: String, reverse: Boolean, query: String): MetaobjectConnection!

## Queries — mobile (2 ops)

mobilePlatformApplication(id: ID!): MobilePlatformApplication
mobilePlatformApplications(first: Int, after: String, last: Int, before: String, reverse: Boolean): MobilePlatformApplicationConnection!

## Queries — node (1 ops)

node(id: ID!): Node

## Queries — nodes (1 ops)

nodes(ids: [ID!]!): [Node]!

## Queries — online (1 ops)

onlineStore: OnlineStore!

## Queries — order (5 ops)

order(id: ID!): Order
orderByIdentifier(identifier: OrderIdentifierInput!): Order
orderEditSession(id: ID!): OrderEditSession
orderPaymentStatus(paymentReferenceId: String!, orderId: ID!): OrderPaymentStatus
orderSavedSearches(first: Int, after: String, last: Int, before: String, reverse: Boolean): SavedSearchConnection!

## Queries — orders (3 ops)

orders(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: OrderSortKeys, query: String, savedSearchId: ID): OrderConnection!
ordersCount(query: String, savedSearchId: ID, limit: Int): Count
pendingOrdersCount: Count

## Queries — page (1 ops)

page(id: ID!): Page

## Queries — pages (2 ops)

pages(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: PageSortKeys, query: String, savedSearchId: ID): PageConnection!
pagesCount(limit: Int): Count

## Queries — payment (3 ops)

paymentCustomization(id: ID!): PaymentCustomization
paymentCustomizations(first: Int, after: String, last: Int, before: String, reverse: Boolean, query: String): PaymentCustomizationConnection!
paymentTermsTemplates(paymentTermsType: PaymentTermsType): [PaymentTermsTemplate!]!

## Queries — point (3 ops)

pointOfSaleDevice(id: ID!): PointOfSaleDevice
pointOfSaleDevicePaymentSession(id: ID!): PointOfSaleDevicePaymentSession
pointOfSaleDevicePaymentSessions(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: PointOfSaleDevicePaymentSessionSortKeys, query: String): PointOfSaleDevicePaymentSessionConnection!

## Queries — price (2 ops)

priceList(id: ID!): PriceList
priceLists(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: PriceListSortKeys): PriceListConnection!

## Queries — privacy (1 ops)

privacySettings: PrivacySettings!

## Queries — product (15 ops)

product(id: ID!): Product
productByIdentifier(identifier: ProductIdentifierInput!): Product
productDuplicateJob(id: ID!): ProductDuplicateJob!
productFeed(id: ID!): ProductFeed
productFeeds(first: Int, after: String, last: Int, before: String, reverse: Boolean): ProductFeedConnection!
productOperation(id: ID!): ProductOperation
productResourceFeedback(id: ID!, channelId: ID): ProductResourceFeedback
productSavedSearches(first: Int, after: String, last: Int, before: String, reverse: Boolean): SavedSearchConnection!
productTags(first: Int, after: String, last: Int, before: String, reverse: Boolean): StringConnection
productTypes(first: Int, after: String, last: Int, before: String, reverse: Boolean): StringConnection
productVariant(id: ID!): ProductVariant
productVariantByIdentifier(identifier: ProductVariantIdentifierInput!): ProductVariant
productVariants(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: ProductVariantSortKeys, query: String, savedSearchId: ID): ProductVariantConnection!
productVariantsCount(query: String, limit: Int): Count
productVendors(first: Int, after: String, last: Int, before: String, reverse: Boolean): StringConnection

## Queries — products (3 ops)

products(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: ProductSortKeys, query: String, savedSearchId: ID): ProductConnection!
productsCount(query: String, savedSearchId: ID, limit: Int): Count
publishedProductsCount(publicationId: ID!, limit: Int): Count

## Queries — public (1 ops)

publicApiVersions: [ApiVersion!]!

## Queries — publication (1 ops)

publication(id: ID!): Publication

## Queries — publications (2 ops)

publications(catalogType: CatalogType, first: Int, after: String, last: Int, before: String, reverse: Boolean): PublicationConnection!
publicationsCount(catalogType: CatalogType, limit: Int): Count

## Queries — refund (1 ops)

refund(id: ID!): Refund

## Queries — return (3 ops)

return(id: ID!): Return
returnCalculate(input: CalculateReturnInput!): CalculatedReturn
returnReasonDefinitions(ids: [ID!], handles: [String!], first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: ReturnReasonDefinitionSortKeys, query: String): ReturnReasonDefinitionConnection!

## Queries — returnable (2 ops)

returnableFulfillment(id: ID!): ReturnableFulfillment
returnableFulfillments(orderId: ID!, first: Int, after: String, last: Int, before: String, reverse: Boolean): ReturnableFulfillmentConnection!

## Queries — reverse (2 ops)

reverseDelivery(id: ID!): ReverseDelivery
reverseFulfillmentOrder(id: ID!): ReverseFulfillmentOrder

## Queries — script (2 ops)

scriptTag(id: ID!): ScriptTag
scriptTags(first: Int, after: String, last: Int, before: String, reverse: Boolean, query: String, src: URL): ScriptTagConnection!

## Queries — segment (5 ops)

segment(id: ID!): Segment
segmentFilterSuggestions(search: String!, first: Int!, after: String): SegmentFilterConnection!
segmentFilters(first: Int, after: String, last: Int, before: String): SegmentFilterConnection!
segmentMigrations(savedSearchId: ID, first: Int, after: String, last: Int, before: String): SegmentMigrationConnection!
segmentValueSuggestions(search: String!, filterQueryName: String, functionParameterQueryName: String, first: Int, after: String, last: Int, before: String): SegmentValueConnection!

## Queries — segments (2 ops)

segments(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: SegmentSortKeys, query: String): SegmentConnection!
segmentsCount(limit: Int): Count

## Queries — selling (2 ops)

sellingPlanGroup(id: ID!): SellingPlanGroup
sellingPlanGroups(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: SellingPlanGroupSortKeys, query: String): SellingPlanGroupConnection!

## Queries — server (1 ops)

serverPixel: ServerPixel

## Queries — shop (5 ops)

shop: Shop!
shopBillingPreferences: ShopBillingPreferences!
shopLocales(published: Boolean): [ShopLocale!]!
shopPayPaymentRequestReceipt(token: String!): ShopPayPaymentRequestReceipt
shopPayPaymentRequestReceipts(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: ShopPayPaymentRequestReceiptsSortKeys, query: String): ShopPayPaymentRequestReceiptConnection

## Queries — shopify (3 ops)

shopifyFunction(id: String!): ShopifyFunction
shopifyFunctions(apiType: String, useCreationUi: Boolean, first: Int, after: String, last: Int, before: String, reverse: Boolean): ShopifyFunctionConnection!
shopifyPaymentsAccount: ShopifyPaymentsAccount

## Queries — shopifyql (1 ops)

shopifyqlQuery(query: String!): ShopifyqlQueryResponse

## Queries — staff (2 ops)

staffMember(id: ID): StaffMember
staffMembers(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: StaffMembersSortKeys, query: String): StaffMemberConnection

## Queries — store (2 ops)

storeCreditAccount(id: ID!): StoreCreditAccount
storeCreditConfiguration: StoreCreditConfiguration!

## Queries — subscription (8 ops)

subscriptionBillingAttempt(id: ID!): SubscriptionBillingAttempt
subscriptionBillingAttempts(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: SubscriptionBillingAttemptsSortKeys, query: String): SubscriptionBillingAttemptConnection!
subscriptionBillingCycle(billingCycleInput: SubscriptionBillingCycleInput!): SubscriptionBillingCycle
subscriptionBillingCycleBulkResults(jobId: ID!, first: Int, after: String, last: Int, before: String, reverse: Boolean): SubscriptionBillingCycleConnection!
subscriptionBillingCycles(contractId: ID!, billingCyclesDateRangeSelector: SubscriptionBillingCyclesDateRangeSelector, billingCyclesIndexRangeSelector: SubscriptionBillingCyclesIndexRangeSelector, first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: SubscriptionBillingCyclesSortKeys): SubscriptionBillingCycleConnection!
subscriptionContract(id: ID!): SubscriptionContract
subscriptionContracts(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: SubscriptionContractsSortKeys, query: String): SubscriptionContractConnection!
subscriptionDraft(id: ID!): SubscriptionDraft

## Queries — taxonomy (1 ops)

taxonomy: Taxonomy

## Queries — tender (1 ops)

tenderTransactions(first: Int, after: String, last: Int, before: String, reverse: Boolean, query: String): TenderTransactionConnection!

## Queries — theme (1 ops)

theme(id: ID!): OnlineStoreTheme

## Queries — themes (1 ops)

themes(roles: [ThemeRole!], names: [String!], first: Int, after: String, last: Int, before: String, reverse: Boolean): OnlineStoreThemeConnection

## Queries — translatable (3 ops)

translatableResource(resourceId: ID!): TranslatableResource
translatableResources(resourceType: TranslatableResourceType!, first: Int, after: String, last: Int, before: String, reverse: Boolean): TranslatableResourceConnection!
translatableResourcesByIds(resourceIds: [ID!]!, first: Int, after: String, last: Int, before: String, reverse: Boolean): TranslatableResourceConnection!

## Queries — url (5 ops)

urlRedirect(id: ID!): UrlRedirect
urlRedirectImport(id: ID!): UrlRedirectImport
urlRedirectSavedSearches(first: Int, after: String, last: Int, before: String, reverse: Boolean): SavedSearchConnection!
urlRedirects(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: UrlRedirectSortKeys, query: String, savedSearchId: ID): UrlRedirectConnection!
urlRedirectsCount(query: String, savedSearchId: ID, limit: Int): Count

## Queries — validation (1 ops)

validation(id: ID!): Validation

## Queries — validations (1 ops)

validations(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: ValidationSortKeys): ValidationConnection!

## Queries — web (2 ops)

webPixel(id: ID): WebPixel
webPresences(first: Int, after: String, last: Int, before: String, reverse: Boolean): MarketWebPresenceConnection

## Queries — webhook (3 ops)

webhookSubscription(id: ID!): WebhookSubscription
webhookSubscriptions(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: WebhookSubscriptionSortKeys, query: String, uri: String, format: WebhookSubscriptionFormat, topics: [WebhookSubscriptionTopic!]): WebhookSubscriptionConnection!
webhookSubscriptionsCount(query: String, limit: Int): Count

## Mutations — abandonment (1 ops)

abandonmentUpdateActivitiesDeliveryStatuses(abandonmentId: ID!, marketingActivityId: ID!, deliveryStatus: AbandonmentDeliveryState!, deliveredAt: DateTime, deliveryStatusChangeReason: String): AbandonmentUpdateActivitiesDeliveryStatusesPayload

## Mutations — app (8 ops)

appPurchaseOneTimeCreate(name: String!, price: MoneyInput!, returnUrl: URL!, test: Boolean): AppPurchaseOneTimeCreatePayload
appRevokeAccessScopes(scopes: [String!]!): AppRevokeAccessScopesPayload
appSubscriptionCancel(id: ID!, prorate: Boolean): AppSubscriptionCancelPayload
appSubscriptionCreate(name: String!, lineItems: [AppSubscriptionLineItemInput!]!, test: Boolean, trialDays: Int, returnUrl: URL!, replacementBehavior: AppSubscriptionReplacementBehavior): AppSubscriptionCreatePayload
appSubscriptionLineItemUpdate(id: ID!, cappedAmount: MoneyInput!): AppSubscriptionLineItemUpdatePayload
appSubscriptionTrialExtend(id: ID!, days: Int!): AppSubscriptionTrialExtendPayload
appUninstall: AppUninstallPayload
appUsageRecordCreate(subscriptionLineItemId: ID!, price: MoneyInput!, description: String!, idempotencyKey: String): AppUsageRecordCreatePayload

## Mutations — article (3 ops)

articleCreate(article: ArticleCreateInput!, blog: ArticleBlogInput): ArticleCreatePayload
articleDelete(id: ID!): ArticleDeletePayload
articleUpdate(id: ID!, article: ArticleUpdateInput!, blog: ArticleBlogInput): ArticleUpdatePayload

## Mutations — backup (1 ops)

backupRegionUpdate(region: BackupRegionUpdateInput): BackupRegionUpdatePayload

## Mutations — blog (3 ops)

blogCreate(blog: BlogCreateInput!): BlogCreatePayload
blogDelete(id: ID!): BlogDeletePayload
blogUpdate(id: ID!, blog: BlogUpdateInput!): BlogUpdatePayload

## Mutations — bulk (4 ops)

bulkOperationCancel(id: ID!): BulkOperationCancelPayload
bulkOperationRunMutation(mutation: String!, stagedUploadPath: String!, clientIdentifier: String): BulkOperationRunMutationPayload
bulkOperationRunQuery(query: String!, groupObjects: Boolean!): BulkOperationRunQueryPayload
bulkProductResourceFeedbackCreate(feedbackInput: [ProductResourceFeedbackInput!]!): BulkProductResourceFeedbackCreatePayload

## Mutations — carrier (3 ops)

carrierServiceCreate(input: DeliveryCarrierServiceCreateInput!): CarrierServiceCreatePayload
carrierServiceDelete(id: ID!): CarrierServiceDeletePayload
carrierServiceUpdate(input: DeliveryCarrierServiceUpdateInput!): CarrierServiceUpdatePayload

## Mutations — cart (2 ops)

cartTransformCreate(functionHandle: String, blockOnFailure: Boolean, metafields: [MetafieldInput!]): CartTransformCreatePayload
cartTransformDelete(id: ID!): CartTransformDeletePayload

## Mutations — cash (5 ops)

cashDrawerCreate(locationId: ID!, name: String!): CashDrawerCreatePayload
cashDrawerFindOrCreate(locationId: ID!, name: String!, pointOfSaleDeviceId: ID!): CashDrawerFindOrCreatePayload
cashDrawerUpdate(id: ID!, input: CashDrawerUpdateInput!): CashDrawerUpdatePayload
cashManagementReasonCodeCreate(code: String!): CashManagementReasonCodeCreatePayload
cashManagementReasonCodeDelete(id: ID!): CashManagementReasonCodeDeletePayload

## Mutations — catalog (4 ops)

catalogContextUpdate(catalogId: ID!, contextsToAdd: CatalogContextInput, contextsToRemove: CatalogContextInput): CatalogContextUpdatePayload
catalogCreate(input: CatalogCreateInput!): CatalogCreatePayload
catalogDelete(id: ID!, deleteDependentResources: Boolean): CatalogDeletePayload
catalogUpdate(id: ID!, input: CatalogUpdateInput!): CatalogUpdatePayload

## Mutations — channel (4 ops)

channelCreate(input: ChannelCreateInput!): ChannelCreatePayload
channelDelete(id: ID!): ChannelDeletePayload
channelFullSync(channelId: ID!, language: LanguageCode, country: CountryCode, beforeUpdatedAt: DateTime, updatedAtSince: DateTime): ChannelFullSyncPayload
channelUpdate(id: ID!, input: ChannelUpdateInput!): ChannelUpdatePayload

## Mutations — checkout (1 ops)

checkoutAndAccountsConfigurationUpdate(id: ID!, configuration: CheckoutAndAccountsConfigurationInput!): CheckoutAndAccountsConfigurationUpdatePayload

## Mutations — collection (8 ops)

collectionAddProducts(id: ID!, productIds: [ID!]!): CollectionAddProductsPayload
collectionAddProductsV2(id: ID!, productIds: [ID!]!): CollectionAddProductsV2Payload
collectionCreate(input: CollectionInput!): CollectionCreatePayload
collectionDelete(input: CollectionDeleteInput!): CollectionDeletePayload
collectionDuplicate(input: CollectionDuplicateInput!): CollectionDuplicatePayload
collectionRemoveProducts(id: ID!, productIds: [ID!]!): CollectionRemoveProductsPayload
collectionReorderProducts(id: ID!, moves: [MoveInput!]!): CollectionReorderProductsPayload
collectionUpdate(input: CollectionInput!): CollectionUpdatePayload

## Mutations — combined (1 ops)

combinedListingUpdate(parentProductId: ID!, title: String, productsAdded: [ChildProductRelationInput!], productsEdited: [ChildProductRelationInput!], productsRemovedIds: [ID!], optionsAndValues: [OptionAndValueInput!]): CombinedListingUpdatePayload

## Mutations — comment (4 ops)

commentApprove(id: ID!): CommentApprovePayload
commentDelete(id: ID!): CommentDeletePayload
commentNotSpam(id: ID!): CommentNotSpamPayload
commentSpam(id: ID!): CommentSpamPayload

## Mutations — companies (1 ops)

companiesDelete(companyIds: [ID!]!): CompaniesDeletePayload

## Mutations — company (27 ops)

companyAddressDelete(addressId: ID!): CompanyAddressDeletePayload
companyAssignCustomerAsContact(companyId: ID!, customerId: ID!): CompanyAssignCustomerAsContactPayload
companyAssignMainContact(companyId: ID!, companyContactId: ID!): CompanyAssignMainContactPayload
companyContactAssignRole(companyContactId: ID!, companyContactRoleId: ID!, companyLocationId: ID!): CompanyContactAssignRolePayload
companyContactAssignRoles(companyContactId: ID!, rolesToAssign: [CompanyContactRoleAssign!]!): CompanyContactAssignRolesPayload
companyContactCreate(companyId: ID!, input: CompanyContactInput!): CompanyContactCreatePayload
companyContactDelete(companyContactId: ID!): CompanyContactDeletePayload
companyContactRemoveFromCompany(companyContactId: ID!): CompanyContactRemoveFromCompanyPayload
companyContactRevokeRole(companyContactId: ID!, companyContactRoleAssignmentId: ID!): CompanyContactRevokeRolePayload
companyContactRevokeRoles(companyContactId: ID!, roleAssignmentIds: [ID!], revokeAll: Boolean): CompanyContactRevokeRolesPayload
companyContactSendWelcomeEmail(companyContactId: ID!, email: EmailInput): CompanyContactSendWelcomeEmailPayload
companyContactUpdate(companyContactId: ID!, input: CompanyContactInput!): CompanyContactUpdatePayload
companyContactsDelete(companyContactIds: [ID!]!): CompanyContactsDeletePayload
companyCreate(input: CompanyCreateInput!): CompanyCreatePayload
companyDelete(id: ID!): CompanyDeletePayload
companyLocationAssignAddress(locationId: ID!, address: CompanyAddressInput!, addressTypes: [CompanyAddressType!]!): CompanyLocationAssignAddressPayload
companyLocationAssignRoles(companyLocationId: ID!, rolesToAssign: [CompanyLocationRoleAssign!]!): CompanyLocationAssignRolesPayload
companyLocationAssignStaffMembers(companyLocationId: ID!, staffMemberIds: [ID!]!): CompanyLocationAssignStaffMembersPayload
companyLocationCreate(companyId: ID!, input: CompanyLocationInput!): CompanyLocationCreatePayload
companyLocationDelete(companyLocationId: ID!): CompanyLocationDeletePayload
companyLocationRemoveStaffMembers(companyLocationStaffMemberAssignmentIds: [ID!]!): CompanyLocationRemoveStaffMembersPayload
companyLocationRevokeRoles(companyLocationId: ID!, rolesToRevoke: [ID!]!): CompanyLocationRevokeRolesPayload
companyLocationTaxSettingsUpdate(companyLocationId: ID!, taxRegistrationId: String, taxExempt: Boolean, exemptionsToAssign: [TaxExemption!], exemptionsToRemove: [TaxExemption!]): CompanyLocationTaxSettingsUpdatePayload
companyLocationUpdate(companyLocationId: ID!, input: CompanyLocationUpdateInput!): CompanyLocationUpdatePayload
companyLocationsDelete(companyLocationIds: [ID!]!): CompanyLocationsDeletePayload
companyRevokeMainContact(companyId: ID!): CompanyRevokeMainContactPayload
companyUpdate(companyId: ID!, input: CompanyInput!): CompanyUpdatePayload

## Mutations — consent (1 ops)

consentPolicyUpdate(consentPolicies: [ConsentPolicyInput!]!): ConsentPolicyUpdatePayload

## Mutations — customer (29 ops)

customerAddTaxExemptions(customerId: ID!, taxExemptions: [TaxExemption!]!): CustomerAddTaxExemptionsPayload
customerAddressCreate(customerId: ID!, address: MailingAddressInput!, setAsDefault: Boolean): CustomerAddressCreatePayload
customerAddressDelete(customerId: ID!, addressId: ID!): CustomerAddressDeletePayload
customerAddressUpdate(customerId: ID!, addressId: ID!, address: MailingAddressInput!, setAsDefault: Boolean): CustomerAddressUpdatePayload
customerCancelDataErasure(customerId: ID!): CustomerCancelDataErasurePayload
customerCreate(input: CustomerInput!): CustomerCreatePayload
customerDelete(input: CustomerDeleteInput!): CustomerDeletePayload
customerEmailMarketingConsentUpdate(input: CustomerEmailMarketingConsentUpdateInput!): CustomerEmailMarketingConsentUpdatePayload
customerGenerateAccountActivationUrl(customerId: ID!): CustomerGenerateAccountActivationUrlPayload
customerMerge(customerOneId: ID!, customerTwoId: ID!, overrideFields: CustomerMergeOverrideFields): CustomerMergePayload
customerPaymentMethodCreateFromDuplicationData(customerId: ID!, billingAddress: MailingAddressInput!, encryptedDuplicationData: String!): CustomerPaymentMethodCreateFromDuplicationDataPayload
customerPaymentMethodCreditCardCreate(customerId: ID!, billingAddress: MailingAddressInput!, sessionId: String!): CustomerPaymentMethodCreditCardCreatePayload
customerPaymentMethodCreditCardUpdate(id: ID!, billingAddress: MailingAddressInput!, sessionId: String!): CustomerPaymentMethodCreditCardUpdatePayload
customerPaymentMethodGetDuplicationData(customerPaymentMethodId: ID!, targetShopId: ID!, targetCustomerId: ID!): CustomerPaymentMethodGetDuplicationDataPayload
customerPaymentMethodGetUpdateUrl(customerPaymentMethodId: ID!): CustomerPaymentMethodGetUpdateUrlPayload
customerPaymentMethodPaypalBillingAgreementCreate(customerId: ID!, billingAddress: MailingAddressInput, billingAgreementId: String!, inactive: Boolean): CustomerPaymentMethodPaypalBillingAgreementCreatePayload
customerPaymentMethodPaypalBillingAgreementUpdate(id: ID!, billingAddress: MailingAddressInput!): CustomerPaymentMethodPaypalBillingAgreementUpdatePayload
customerPaymentMethodRemoteCreate(customerId: ID!, remoteReference: CustomerPaymentMethodRemoteInput!): CustomerPaymentMethodRemoteCreatePayload
customerPaymentMethodRevoke(customerPaymentMethodId: ID!): CustomerPaymentMethodRevokePayload
customerPaymentMethodSendUpdateEmail(customerPaymentMethodId: ID!, email: EmailInput): CustomerPaymentMethodSendUpdateEmailPayload
customerRemoveTaxExemptions(customerId: ID!, taxExemptions: [TaxExemption!]!): CustomerRemoveTaxExemptionsPayload
customerReplaceTaxExemptions(customerId: ID!, taxExemptions: [TaxExemption!]!): CustomerReplaceTaxExemptionsPayload
customerRequestDataErasure(customerId: ID!): CustomerRequestDataErasurePayload
customerSegmentMembersQueryCreate(input: CustomerSegmentMembersQueryInput!): CustomerSegmentMembersQueryCreatePayload
customerSendAccountInviteEmail(customerId: ID!, email: EmailInput): CustomerSendAccountInviteEmailPayload
customerSet(input: CustomerSetInput!, identifier: CustomerSetIdentifiers): CustomerSetPayload
customerSmsMarketingConsentUpdate(input: CustomerSmsMarketingConsentUpdateInput!): CustomerSmsMarketingConsentUpdatePayload
customerUpdate(input: CustomerInput!): CustomerUpdatePayload
customerUpdateDefaultAddress(customerId: ID!, addressId: ID!): CustomerUpdateDefaultAddressPayload

## Mutations — data (1 ops)

dataSaleOptOut(email: String!): DataSaleOptOutPayload

## Mutations — delegate (2 ops)

delegateAccessTokenCreate(input: DelegateAccessTokenInput!): DelegateAccessTokenCreatePayload
delegateAccessTokenDestroy(accessToken: String!): DelegateAccessTokenDestroyPayload

## Mutations — delivery (10 ops)

deliveryCustomizationActivation(ids: [ID!]!, enabled: Boolean!): DeliveryCustomizationActivationPayload
deliveryCustomizationCreate(deliveryCustomization: DeliveryCustomizationInput!): DeliveryCustomizationCreatePayload
deliveryCustomizationDelete(id: ID!): DeliveryCustomizationDeletePayload
deliveryCustomizationUpdate(id: ID!, deliveryCustomization: DeliveryCustomizationInput!): DeliveryCustomizationUpdatePayload
deliveryProfileCreate(profile: DeliveryProfileInput!): DeliveryProfileCreatePayload
deliveryProfileRemove(id: ID!): DeliveryProfileRemovePayload
deliveryProfileUpdate(id: ID!, profile: DeliveryProfileInput!): DeliveryProfileUpdatePayload
deliveryPromiseParticipantsUpdate(brandedPromiseHandle: String!, ownersToAdd: [ID!], ownersToRemove: [ID!]): DeliveryPromiseParticipantsUpdatePayload
deliveryPromiseProviderUpsert(active: Boolean, fulfillmentDelay: Int, timeZone: String, locationId: ID!): DeliveryPromiseProviderUpsertPayload
deliverySettingUpdate: DeliverySettingUpdatePayload

## Mutations — discount (30 ops)

discountAutomaticActivate(id: ID!): DiscountAutomaticActivatePayload
discountAutomaticAppCreate(automaticAppDiscount: DiscountAutomaticAppInput!): DiscountAutomaticAppCreatePayload
discountAutomaticAppUpdate(id: ID!, automaticAppDiscount: DiscountAutomaticAppInput!): DiscountAutomaticAppUpdatePayload
discountAutomaticBasicCreate(automaticBasicDiscount: DiscountAutomaticBasicInput!): DiscountAutomaticBasicCreatePayload
discountAutomaticBasicUpdate(id: ID!, automaticBasicDiscount: DiscountAutomaticBasicInput!): DiscountAutomaticBasicUpdatePayload
discountAutomaticBulkDelete(search: String, savedSearchId: ID, ids: [ID!]): DiscountAutomaticBulkDeletePayload
discountAutomaticBxgyCreate(automaticBxgyDiscount: DiscountAutomaticBxgyInput!): DiscountAutomaticBxgyCreatePayload
discountAutomaticBxgyUpdate(id: ID!, automaticBxgyDiscount: DiscountAutomaticBxgyInput!): DiscountAutomaticBxgyUpdatePayload
discountAutomaticDeactivate(id: ID!): DiscountAutomaticDeactivatePayload
discountAutomaticDelete(id: ID!): DiscountAutomaticDeletePayload
discountAutomaticFreeShippingCreate(freeShippingAutomaticDiscount: DiscountAutomaticFreeShippingInput!): DiscountAutomaticFreeShippingCreatePayload
discountAutomaticFreeShippingUpdate(id: ID!, freeShippingAutomaticDiscount: DiscountAutomaticFreeShippingInput!): DiscountAutomaticFreeShippingUpdatePayload
discountBulkTagsAdd(search: String, savedSearchId: ID, ids: [ID!], tags: [String!]!): DiscountBulkTagsAddPayload
discountBulkTagsRemove(search: String, savedSearchId: ID, ids: [ID!], tags: [String!]!): DiscountBulkTagsRemovePayload
discountCodeActivate(id: ID!): DiscountCodeActivatePayload
discountCodeAppCreate(codeAppDiscount: DiscountCodeAppInput!): DiscountCodeAppCreatePayload
discountCodeAppUpdate(id: ID!, codeAppDiscount: DiscountCodeAppInput!): DiscountCodeAppUpdatePayload
discountCodeBasicCreate(basicCodeDiscount: DiscountCodeBasicInput!): DiscountCodeBasicCreatePayload
discountCodeBasicUpdate(id: ID!, basicCodeDiscount: DiscountCodeBasicInput!): DiscountCodeBasicUpdatePayload
discountCodeBulkActivate(search: String, savedSearchId: ID, ids: [ID!]): DiscountCodeBulkActivatePayload
discountCodeBulkDeactivate(search: String, savedSearchId: ID, ids: [ID!]): DiscountCodeBulkDeactivatePayload
discountCodeBulkDelete(search: String, savedSearchId: ID, ids: [ID!]): DiscountCodeBulkDeletePayload
discountCodeBxgyCreate(bxgyCodeDiscount: DiscountCodeBxgyInput!): DiscountCodeBxgyCreatePayload
discountCodeBxgyUpdate(id: ID!, bxgyCodeDiscount: DiscountCodeBxgyInput!): DiscountCodeBxgyUpdatePayload
discountCodeDeactivate(id: ID!): DiscountCodeDeactivatePayload
discountCodeDelete(id: ID!): DiscountCodeDeletePayload
discountCodeFreeShippingCreate(freeShippingCodeDiscount: DiscountCodeFreeShippingInput!): DiscountCodeFreeShippingCreatePayload
discountCodeFreeShippingUpdate(id: ID!, freeShippingCodeDiscount: DiscountCodeFreeShippingInput!): DiscountCodeFreeShippingUpdatePayload
discountCodeRedeemCodeBulkDelete(discountId: ID!, search: String, savedSearchId: ID, ids: [ID!]): DiscountCodeRedeemCodeBulkDeletePayload
discountRedeemCodeBulkAdd(discountId: ID!, codes: [DiscountRedeemCodeInput!]!): DiscountRedeemCodeBulkAddPayload

## Mutations — dispute (1 ops)

disputeEvidenceUpdate(id: ID!, input: ShopifyPaymentsDisputeEvidenceUpdateInput!): DisputeEvidenceUpdatePayload

## Mutations — draft (12 ops)

draftOrderBulkAddTags(search: String, savedSearchId: ID, ids: [ID!], tags: [String!]!): DraftOrderBulkAddTagsPayload
draftOrderBulkDelete(search: String, savedSearchId: ID, ids: [ID!]): DraftOrderBulkDeletePayload
draftOrderBulkRemoveTags(search: String, savedSearchId: ID, ids: [ID!], tags: [String!]!): DraftOrderBulkRemoveTagsPayload
draftOrderCalculate(input: DraftOrderInput!): DraftOrderCalculatePayload
draftOrderComplete(id: ID!, paymentGatewayId: ID, sourceName: String): DraftOrderCompletePayload
draftOrderCreate(input: DraftOrderInput!): DraftOrderCreatePayload
draftOrderCreateFromOrder(orderId: ID!): DraftOrderCreateFromOrderPayload
draftOrderDelete(input: DraftOrderDeleteInput!): DraftOrderDeletePayload
draftOrderDuplicate(id: ID): DraftOrderDuplicatePayload
draftOrderInvoicePreview(id: ID!, email: EmailInput): DraftOrderInvoicePreviewPayload
draftOrderInvoiceSend(id: ID!, email: EmailInput): DraftOrderInvoiceSendPayload
draftOrderUpdate(id: ID!, input: DraftOrderInput!): DraftOrderUpdatePayload

## Mutations — event (1 ops)

eventBridgeServerPixelUpdate(arn: ARN!): EventBridgeServerPixelUpdatePayload

## Mutations — file (4 ops)

fileAcknowledgeUpdateFailed(fileIds: [ID!]!): FileAcknowledgeUpdateFailedPayload
fileCreate(files: [FileCreateInput!]!): FileCreatePayload
fileDelete(fileIds: [ID!]!): FileDeletePayload
fileUpdate(files: [FileUpdateInput!]!): FileUpdatePayload

## Mutations — flow (2 ops)

flowGenerateSignature(id: ID!, payload: String!): FlowGenerateSignaturePayload
flowTriggerReceive(handle: String, payload: JSON): FlowTriggerReceivePayload

## Mutations — fulfillment (29 ops)

fulfillmentCancel(id: ID!): FulfillmentCancelPayload
fulfillmentConstraintRuleCreate(functionHandle: String, deliveryMethodTypes: [DeliveryMethodType!]!, metafields: [MetafieldInput!]): FulfillmentConstraintRuleCreatePayload
fulfillmentConstraintRuleDelete(id: ID!): FulfillmentConstraintRuleDeletePayload
fulfillmentConstraintRuleUpdate(id: ID!, deliveryMethodTypes: [DeliveryMethodType!]!): FulfillmentConstraintRuleUpdatePayload
fulfillmentCreate(fulfillment: FulfillmentInput!, message: String): FulfillmentCreatePayload
fulfillmentEventCreate(fulfillmentEvent: FulfillmentEventInput!): FulfillmentEventCreatePayload
fulfillmentOrderAcceptCancellationRequest(id: ID!, message: String): FulfillmentOrderAcceptCancellationRequestPayload
fulfillmentOrderAcceptFulfillmentRequest(id: ID!, message: String, estimatedShippedAt: DateTime): FulfillmentOrderAcceptFulfillmentRequestPayload
fulfillmentOrderCancel(id: ID!): FulfillmentOrderCancelPayload
fulfillmentOrderClose(id: ID!, message: String): FulfillmentOrderClosePayload
fulfillmentOrderHold(id: ID!, fulfillmentHold: FulfillmentOrderHoldInput!): FulfillmentOrderHoldPayload
fulfillmentOrderLineItemsPreparedForPickup(input: FulfillmentOrderLineItemsPreparedForPickupInput!): FulfillmentOrderLineItemsPreparedForPickupPayload
fulfillmentOrderMerge(fulfillmentOrderMergeInputs: [FulfillmentOrderMergeInput!]!): FulfillmentOrderMergePayload
fulfillmentOrderMove(id: ID!, newLocationId: ID!, fulfillmentOrderLineItems: [FulfillmentOrderLineItemInput!]): FulfillmentOrderMovePayload
fulfillmentOrderOpen(id: ID!): FulfillmentOrderOpenPayload
fulfillmentOrderRejectCancellationRequest(id: ID!, message: String): FulfillmentOrderRejectCancellationRequestPayload
fulfillmentOrderRejectFulfillmentRequest(id: ID!, reason: FulfillmentOrderRejectionReason, message: String, lineItems: [IncomingRequestLineItemInput!]): FulfillmentOrderRejectFulfillmentRequestPayload
fulfillmentOrderReleaseHold(id: ID!, holdIds: [ID!], externalId: String): FulfillmentOrderReleaseHoldPayload
fulfillmentOrderReportProgress(id: ID!, progressReport: FulfillmentOrderReportProgressInput): FulfillmentOrderReportProgressPayload
fulfillmentOrderReschedule(id: ID!, fulfillAt: DateTime!): FulfillmentOrderReschedulePayload
fulfillmentOrderSplit(fulfillmentOrderSplits: [FulfillmentOrderSplitInput!]!): FulfillmentOrderSplitPayload
fulfillmentOrderSubmitCancellationRequest(id: ID!, message: String): FulfillmentOrderSubmitCancellationRequestPayload
fulfillmentOrderSubmitFulfillmentRequest(id: ID!, message: String, notifyCustomer: Boolean, fulfillmentOrderLineItems: [FulfillmentOrderLineItemInput!]): FulfillmentOrderSubmitFulfillmentRequestPayload
fulfillmentOrdersReroute(fulfillmentOrderIds: [ID!]!, includedLocationIds: [ID!], excludedLocationIds: [ID!]): FulfillmentOrdersReroutePayload
fulfillmentOrdersSetFulfillmentDeadline(fulfillmentOrderIds: [ID!]!, fulfillmentDeadline: DateTime!): FulfillmentOrdersSetFulfillmentDeadlinePayload
fulfillmentServiceCreate(name: String!, callbackUrl: URL, trackingSupport: Boolean, inventoryManagement: Boolean, requiresShippingMethod: Boolean): FulfillmentServiceCreatePayload
fulfillmentServiceDelete(id: ID!, destinationLocationId: ID, inventoryAction: FulfillmentServiceDeleteInventoryAction): FulfillmentServiceDeletePayload
fulfillmentServiceUpdate(id: ID!, name: String, callbackUrl: URL, trackingSupport: Boolean, inventoryManagement: Boolean, requiresShippingMethod: Boolean): FulfillmentServiceUpdatePayload
fulfillmentTrackingInfoUpdate(fulfillmentId: ID!, trackingInfoInput: FulfillmentTrackingInput!, notifyCustomer: Boolean): FulfillmentTrackingInfoUpdatePayload

## Mutations — gift (7 ops)

giftCardCreate(input: GiftCardCreateInput!): GiftCardCreatePayload
giftCardCredit(id: ID!, creditInput: GiftCardCreditInput!): GiftCardCreditPayload
giftCardDeactivate(id: ID!): GiftCardDeactivatePayload
giftCardDebit(id: ID!, debitInput: GiftCardDebitInput!): GiftCardDebitPayload
giftCardSendNotificationToCustomer(id: ID!): GiftCardSendNotificationToCustomerPayload
giftCardSendNotificationToRecipient(id: ID!): GiftCardSendNotificationToRecipientPayload
giftCardUpdate(id: ID!, input: GiftCardUpdateInput!): GiftCardUpdatePayload

## Mutations — inventory (26 ops)

inventoryActivate(inventoryItemId: ID!, locationId: ID!, available: Int, onHand: Int, stockAtLegacyLocation: Boolean): InventoryActivatePayload
inventoryAdjustQuantities(input: InventoryAdjustQuantitiesInput!): InventoryAdjustQuantitiesPayload
inventoryBulkToggleActivation(inventoryItemId: ID!, inventoryItemUpdates: [InventoryBulkToggleActivationInput!]!): InventoryBulkToggleActivationPayload
inventoryDeactivate(inventoryLevelId: ID!): InventoryDeactivatePayload
inventoryItemUpdate(id: ID!, input: InventoryItemInput!): InventoryItemUpdatePayload
inventoryMoveQuantities(input: InventoryMoveQuantitiesInput!): InventoryMoveQuantitiesPayload
inventorySetQuantities(input: InventorySetQuantitiesInput!): InventorySetQuantitiesPayload
inventoryShipmentAddItems(id: ID!, lineItems: [InventoryShipmentLineItemInput!]!): InventoryShipmentAddItemsPayload
inventoryShipmentCreate(input: InventoryShipmentCreateInput!): InventoryShipmentCreatePayload
inventoryShipmentCreateInTransit(input: InventoryShipmentCreateInput!): InventoryShipmentCreateInTransitPayload
inventoryShipmentDelete(id: ID!): InventoryShipmentDeletePayload
inventoryShipmentMarkInTransit(id: ID!, dateShipped: DateTime): InventoryShipmentMarkInTransitPayload
inventoryShipmentReceive(id: ID!, lineItems: [InventoryShipmentReceiveItemInput!], dateReceived: DateTime, bulkReceiveAction: InventoryShipmentReceiveLineItemReason): InventoryShipmentReceivePayload
inventoryShipmentRemoveItems(id: ID!, lineItems: [ID!]!): InventoryShipmentRemoveItemsPayload
inventoryShipmentSetBarcode(id: ID!, barcode: String!): InventoryShipmentSetBarcodePayload
inventoryShipmentSetTracking(id: ID!, tracking: InventoryShipmentTrackingInput!): InventoryShipmentSetTrackingPayload
inventoryShipmentUpdateItemQuantities(id: ID!, items: [InventoryShipmentUpdateItemQuantitiesInput!]): InventoryShipmentUpdateItemQuantitiesPayload
inventoryTransferCancel(id: ID!): InventoryTransferCancelPayload
inventoryTransferCreate(input: InventoryTransferCreateInput!): InventoryTransferCreatePayload
inventoryTransferCreateAsReadyToShip(input: InventoryTransferCreateAsReadyToShipInput!): InventoryTransferCreateAsReadyToShipPayload
inventoryTransferDelete(id: ID!): InventoryTransferDeletePayload
inventoryTransferDuplicate(id: ID!): InventoryTransferDuplicatePayload
inventoryTransferEdit(id: ID!, input: InventoryTransferEditInput!): InventoryTransferEditPayload
inventoryTransferMarkAsReadyToShip(id: ID!): InventoryTransferMarkAsReadyToShipPayload
inventoryTransferRemoveItems(input: InventoryTransferRemoveItemsInput!): InventoryTransferRemoveItemsPayload
inventoryTransferSetItems(input: InventoryTransferSetItemsInput!): InventoryTransferSetItemsPayload

## Mutations — location (7 ops)

locationActivate(locationId: ID!): LocationActivatePayload
locationAdd(input: LocationAddInput!): LocationAddPayload
locationDeactivate(locationId: ID!, destinationLocationId: ID): LocationDeactivatePayload
locationDelete(locationId: ID!): LocationDeletePayload
locationEdit(id: ID!, input: LocationEditInput!): LocationEditPayload
locationLocalPickupDisable(locationId: ID!): LocationLocalPickupDisablePayload
locationLocalPickupEnable(localPickupSettings: DeliveryLocationLocalPickupEnableInput!): LocationLocalPickupEnablePayload

## Mutations — market (5 ops)

marketCreate(input: MarketCreateInput!): MarketCreatePayload
marketDelete(id: ID!): MarketDeletePayload
marketLocalizationsRegister(resourceId: ID!, marketLocalizations: [MarketLocalizationRegisterInput!]!): MarketLocalizationsRegisterPayload
marketLocalizationsRemove(resourceId: ID!, marketLocalizationKeys: [String!]!, marketIds: [ID!]!): MarketLocalizationsRemovePayload
marketUpdate(id: ID!, input: MarketUpdateInput!): MarketUpdatePayload

## Mutations — marketing (9 ops)

marketingActivitiesDeleteAllExternal: MarketingActivitiesDeleteAllExternalPayload
marketingActivityCreate(input: MarketingActivityCreateInput!): MarketingActivityCreatePayload
marketingActivityCreateExternal(input: MarketingActivityCreateExternalInput!): MarketingActivityCreateExternalPayload
marketingActivityDeleteExternal(marketingActivityId: ID, remoteId: String): MarketingActivityDeleteExternalPayload
marketingActivityUpdate(input: MarketingActivityUpdateInput!): MarketingActivityUpdatePayload
marketingActivityUpdateExternal(input: MarketingActivityUpdateExternalInput!, marketingActivityId: ID, remoteId: String, utm: UTMInput): MarketingActivityUpdateExternalPayload
marketingActivityUpsertExternal(input: MarketingActivityUpsertExternalInput!): MarketingActivityUpsertExternalPayload
marketingEngagementCreate(marketingActivityId: ID, remoteId: String, channelHandle: String, marketingEngagement: MarketingEngagementInput!): MarketingEngagementCreatePayload
marketingEngagementsDelete(channelHandle: String, deleteEngagementsForAllChannels: Boolean): MarketingEngagementsDeletePayload

## Mutations — menu (3 ops)

menuCreate(title: String!, handle: String!, items: [MenuItemCreateInput!]!): MenuCreatePayload
menuDelete(id: ID!): MenuDeletePayload
menuUpdate(id: ID!, title: String!, handle: String, items: [MenuItemUpdateInput!]!): MenuUpdatePayload

## Mutations — metafield (6 ops)

metafieldDefinitionCreate(definition: MetafieldDefinitionInput!): MetafieldDefinitionCreatePayload
metafieldDefinitionDelete(id: ID, identifier: MetafieldDefinitionIdentifierInput, deleteAllAssociatedMetafields: Boolean): MetafieldDefinitionDeletePayload
metafieldDefinitionPin(definitionId: ID, identifier: MetafieldDefinitionIdentifierInput): MetafieldDefinitionPinPayload
metafieldDefinitionUnpin(definitionId: ID, identifier: MetafieldDefinitionIdentifierInput): MetafieldDefinitionUnpinPayload
metafieldDefinitionUpdate(definition: MetafieldDefinitionUpdateInput!): MetafieldDefinitionUpdatePayload
standardMetafieldDefinitionEnable(ownerType: MetafieldOwnerType!, id: ID, namespace: String, key: String, pin: Boolean, capabilities: MetafieldCapabilityCreateInput, access: StandardMetafieldDefinitionAccessInput): StandardMetafieldDefinitionEnablePayload

## Mutations — metafields (2 ops)

metafieldsDelete(metafields: [MetafieldIdentifierInput!]!): MetafieldsDeletePayload
metafieldsSet(metafields: [MetafieldsSetInput!]!): MetafieldsSetPayload

## Mutations — metaobject (9 ops)

metaobjectBulkDelete(where: MetaobjectBulkDeleteWhereCondition!): MetaobjectBulkDeletePayload
metaobjectCreate(metaobject: MetaobjectCreateInput!): MetaobjectCreatePayload
metaobjectDefinitionCreate(definition: MetaobjectDefinitionCreateInput!): MetaobjectDefinitionCreatePayload
metaobjectDefinitionDelete(id: ID!): MetaobjectDefinitionDeletePayload
metaobjectDefinitionUpdate(id: ID!, definition: MetaobjectDefinitionUpdateInput!): MetaobjectDefinitionUpdatePayload
metaobjectDelete(id: ID!): MetaobjectDeletePayload
metaobjectUpdate(id: ID!, metaobject: MetaobjectUpdateInput!): MetaobjectUpdatePayload
metaobjectUpsert(handle: MetaobjectHandleInput!, metaobject: MetaobjectUpsertInput!): MetaobjectUpsertPayload
standardMetaobjectDefinitionEnable(type: String!): StandardMetaobjectDefinitionEnablePayload

## Mutations — mobile (3 ops)

mobilePlatformApplicationCreate(input: MobilePlatformApplicationCreateInput!): MobilePlatformApplicationCreatePayload
mobilePlatformApplicationDelete(id: ID!): MobilePlatformApplicationDeletePayload
mobilePlatformApplicationUpdate(id: ID!, input: MobilePlatformApplicationUpdateInput!): MobilePlatformApplicationUpdatePayload

## Mutations — order (25 ops)

orderCancel(orderId: ID!, refundMethod: OrderCancelRefundMethodInput, restock: Boolean!, reason: OrderCancelReason!, notifyCustomer: Boolean, staffNote: String): OrderCancelPayload
orderCapture(input: OrderCaptureInput!): OrderCapturePayload
orderClose(input: OrderCloseInput!): OrderClosePayload
orderCreate(order: OrderCreateOrderInput!, options: OrderCreateOptionsInput): OrderCreatePayload
orderCreateMandatePayment(id: ID!, paymentScheduleId: ID, idempotencyKey: String!, mandateId: ID!, amount: MoneyInput, autoCapture: Boolean): OrderCreateMandatePaymentPayload
orderCreateManualPayment(id: ID!, amount: MoneyInput, paymentMethodName: String, processedAt: DateTime): OrderCreateManualPaymentPayload
orderCustomerRemove(orderId: ID!): OrderCustomerRemovePayload
orderCustomerSet(orderId: ID!, customerId: ID!): OrderCustomerSetPayload
orderDelete(orderId: ID!): OrderDeletePayload
orderEditAddCustomItem(id: ID!, title: String!, locationId: ID, price: MoneyInput!, quantity: Int!, taxable: Boolean, requiresShipping: Boolean): OrderEditAddCustomItemPayload
orderEditAddLineItemDiscount(id: ID!, lineItemId: ID!, discount: OrderEditAppliedDiscountInput!): OrderEditAddLineItemDiscountPayload
orderEditAddShippingLine(id: ID!, shippingLine: OrderEditAddShippingLineInput!): OrderEditAddShippingLinePayload
orderEditAddVariant(id: ID!, variantId: ID!, locationId: ID, quantity: Int!, allowDuplicates: Boolean): OrderEditAddVariantPayload
orderEditBegin(id: ID!): OrderEditBeginPayload
orderEditCommit(id: ID!, notifyCustomer: Boolean, staffNote: String): OrderEditCommitPayload
orderEditRemoveDiscount(id: ID!, discountApplicationId: ID!): OrderEditRemoveDiscountPayload
orderEditRemoveShippingLine(id: ID!, shippingLineId: ID!): OrderEditRemoveShippingLinePayload
orderEditSetQuantity(id: ID!, lineItemId: ID!, quantity: Int!, restock: Boolean): OrderEditSetQuantityPayload
orderEditUpdateDiscount(id: ID!, discount: OrderEditAppliedDiscountInput!, discountApplicationId: ID!): OrderEditUpdateDiscountPayload
orderEditUpdateShippingLine(id: ID!, shippingLine: OrderEditUpdateShippingLineInput!, shippingLineId: ID!): OrderEditUpdateShippingLinePayload
orderInvoiceSend(id: ID!, email: EmailInput): OrderInvoiceSendPayload
orderMarkAsPaid(input: OrderMarkAsPaidInput!): OrderMarkAsPaidPayload
orderOpen(input: OrderOpenInput!): OrderOpenPayload
orderRiskAssessmentCreate(orderRiskAssessmentInput: OrderRiskAssessmentCreateInput!): OrderRiskAssessmentCreatePayload
orderUpdate(input: OrderInput!): OrderUpdatePayload

## Mutations — page (3 ops)

pageCreate(page: PageCreateInput!): PageCreatePayload
pageDelete(id: ID!): PageDeletePayload
pageUpdate(id: ID!, page: PageUpdateInput!): PageUpdatePayload

## Mutations — payment (8 ops)

paymentCustomizationActivation(ids: [ID!]!, enabled: Boolean!): PaymentCustomizationActivationPayload
paymentCustomizationCreate(paymentCustomization: PaymentCustomizationInput!): PaymentCustomizationCreatePayload
paymentCustomizationDelete(id: ID!): PaymentCustomizationDeletePayload
paymentCustomizationUpdate(id: ID!, paymentCustomization: PaymentCustomizationInput!): PaymentCustomizationUpdatePayload
paymentReminderSend(paymentScheduleId: ID!): PaymentReminderSendPayload
paymentTermsCreate(referenceId: ID!, paymentTermsAttributes: PaymentTermsCreateInput!): PaymentTermsCreatePayload
paymentTermsDelete(input: PaymentTermsDeleteInput!): PaymentTermsDeletePayload
paymentTermsUpdate(input: PaymentTermsUpdateInput!): PaymentTermsUpdatePayload

## Mutations — point (5 ops)

pointOfSaleDeviceAssignToCashDrawer(cashDrawerId: ID!, pointOfSaleDeviceId: ID!): PointOfSaleDeviceAssignToCashDrawerPayload
pointOfSaleDevicePaymentSessionAdjust(pointOfSaleDevicePaymentSessionId: ID!, cash: MoneyInput!, staffMemberId: ID!, reasonCodeId: ID, note: String, time: DateTime): PointOfSaleDevicePaymentSessionAdjustPayload
pointOfSaleDevicePaymentSessionClose(pointOfSaleDevicePaymentSessionId: ID!, balance: MoneyInput!, staffMemberId: ID!, time: DateTime, reasonCodeId: ID, note: String): PointOfSaleDevicePaymentSessionClosePayload
pointOfSaleDevicePaymentSessionCount(pointOfSaleDevicePaymentSessionId: ID!, balance: MoneyInput!, staffMemberId: ID!, time: DateTime, reasonCodeId: ID, note: String): PointOfSaleDevicePaymentSessionCountPayload
pointOfSaleDevicePaymentSessionOpen(pointOfSaleDeviceId: ID!, balance: MoneyInput, staffMemberId: ID!, time: DateTime, reasonCodeId: ID, note: String): PointOfSaleDevicePaymentSessionOpenPayload

## Mutations — price (7 ops)

priceListCreate(input: PriceListCreateInput!): PriceListCreatePayload
priceListDelete(id: ID!): PriceListDeletePayload
priceListFixedPricesAdd(priceListId: ID!, prices: [PriceListPriceInput!]!): PriceListFixedPricesAddPayload
priceListFixedPricesByProductUpdate(pricesToAdd: [PriceListProductPriceInput!], pricesToDeleteByProductIds: [ID!], priceListId: ID!): PriceListFixedPricesByProductUpdatePayload
priceListFixedPricesDelete(priceListId: ID!, variantIds: [ID!]!): PriceListFixedPricesDeletePayload
priceListFixedPricesUpdate(priceListId: ID!, pricesToAdd: [PriceListPriceInput!]!, variantIdsToDelete: [ID!]!): PriceListFixedPricesUpdatePayload
priceListUpdate(id: ID!, input: PriceListUpdateInput!): PriceListUpdatePayload

## Mutations — privacy (1 ops)

privacyFeaturesDisable(featuresToDisable: [PrivacyFeaturesEnum!]!): PrivacyFeaturesDisablePayload

## Mutations — product (26 ops)

productBundleCreate(input: ProductBundleCreateInput!): ProductBundleCreatePayload
productBundleUpdate(input: ProductBundleUpdateInput!): ProductBundleUpdatePayload
productCreate(product: ProductCreateInput, media: [CreateMediaInput!]): ProductCreatePayload
productDelete(input: ProductDeleteInput!, synchronous: Boolean): ProductDeletePayload
productDuplicate(productId: ID!, newTitle: String!, newStatus: ProductStatus, includeImages: Boolean, includeTranslations: Boolean, synchronous: Boolean): ProductDuplicatePayload
productFeedCreate(input: ProductFeedInput): ProductFeedCreatePayload
productFeedDelete(id: ID!): ProductFeedDeletePayload
productFullSync(beforeUpdatedAt: DateTime, id: ID!, updatedAtSince: DateTime): ProductFullSyncPayload
productJoinSellingPlanGroups(id: ID!, sellingPlanGroupIds: [ID!]!): ProductJoinSellingPlanGroupsPayload
productLeaveSellingPlanGroups(id: ID!, sellingPlanGroupIds: [ID!]!): ProductLeaveSellingPlanGroupsPayload
productOptionUpdate(option: OptionUpdateInput!, productId: ID!, optionValuesToAdd: [OptionValueCreateInput!], optionValuesToUpdate: [OptionValueUpdateInput!], optionValuesToDelete: [ID!], variantStrategy: ProductOptionUpdateVariantStrategy): ProductOptionUpdatePayload
productOptionsCreate(productId: ID!, options: [OptionCreateInput!]!, variantStrategy: ProductOptionCreateVariantStrategy): ProductOptionsCreatePayload
productOptionsDelete(productId: ID!, options: [ID!]!, strategy: ProductOptionDeleteStrategy): ProductOptionsDeletePayload
productOptionsReorder(productId: ID!, options: [OptionReorderInput!]!): ProductOptionsReorderPayload
productReorderMedia(id: ID!, moves: [MoveInput!]!): ProductReorderMediaPayload
productSet(input: ProductSetInput!, synchronous: Boolean, identifier: ProductSetIdentifiers): ProductSetPayload
productUpdate(product: ProductUpdateInput, media: [CreateMediaInput!], identifier: ProductUpdateIdentifiers): ProductUpdatePayload
productVariantAppendMedia(productId: ID!, variantMedia: [ProductVariantAppendMediaInput!]!): ProductVariantAppendMediaPayload
productVariantDetachMedia(productId: ID!, variantMedia: [ProductVariantDetachMediaInput!]!): ProductVariantDetachMediaPayload
productVariantJoinSellingPlanGroups(id: ID!, sellingPlanGroupIds: [ID!]!): ProductVariantJoinSellingPlanGroupsPayload
productVariantLeaveSellingPlanGroups(id: ID!, sellingPlanGroupIds: [ID!]!): ProductVariantLeaveSellingPlanGroupsPayload
productVariantRelationshipBulkUpdate(input: [ProductVariantRelationshipUpdateInput!]!): ProductVariantRelationshipBulkUpdatePayload
productVariantsBulkCreate(variants: [ProductVariantsBulkInput!]!, productId: ID!, media: [CreateMediaInput!], strategy: ProductVariantsBulkCreateStrategy): ProductVariantsBulkCreatePayload
productVariantsBulkDelete(variantsIds: [ID!]!, productId: ID!): ProductVariantsBulkDeletePayload
productVariantsBulkReorder(productId: ID!, positions: [ProductVariantPositionInput!]!): ProductVariantsBulkReorderPayload
productVariantsBulkUpdate(variants: [ProductVariantsBulkInput!]!, productId: ID!, media: [CreateMediaInput!], allowPartialUpdates: Boolean): ProductVariantsBulkUpdatePayload

## Mutations — pub (1 ops)

pubSubServerPixelUpdate(pubSubProject: String!, pubSubTopic: String!): PubSubServerPixelUpdatePayload

## Mutations — publication (3 ops)

publicationCreate(input: PublicationCreateInput!): PublicationCreatePayload
publicationDelete(id: ID!): PublicationDeletePayload
publicationUpdate(id: ID!, input: PublicationUpdateInput!): PublicationUpdatePayload

## Mutations — publishable (2 ops)

publishablePublish(id: ID!, input: [PublicationInput!]!): PublishablePublishPayload
publishableUnpublish(id: ID!, input: [PublicationInput!]!): PublishableUnpublishPayload

## Mutations — quantity (3 ops)

quantityPricingByVariantUpdate(priceListId: ID!, input: QuantityPricingByVariantUpdateInput!): QuantityPricingByVariantUpdatePayload
quantityRulesAdd(priceListId: ID!, quantityRules: [QuantityRuleInput!]!): QuantityRulesAddPayload
quantityRulesDelete(priceListId: ID!, variantIds: [ID!]!): QuantityRulesDeletePayload

## Mutations — refund (1 ops)

refundCreate(input: RefundInput!): RefundCreatePayload

## Mutations — return (9 ops)

removeFromReturn(returnId: ID!, returnLineItems: [ReturnLineItemRemoveFromReturnInput!], exchangeLineItems: [ExchangeLineItemRemoveFromReturnInput!]): RemoveFromReturnPayload
returnApproveRequest(input: ReturnApproveRequestInput!): ReturnApproveRequestPayload
returnCancel(id: ID!): ReturnCancelPayload
returnClose(id: ID!): ReturnClosePayload
returnCreate(returnInput: ReturnInput!): ReturnCreatePayload
returnDeclineRequest(input: ReturnDeclineRequestInput!): ReturnDeclineRequestPayload
returnProcess(input: ReturnProcessInput!): ReturnProcessPayload
returnReopen(id: ID!): ReturnReopenPayload
returnRequest(input: ReturnRequestInput!): ReturnRequestPayload

## Mutations — reverse (3 ops)

reverseDeliveryCreateWithShipping(reverseFulfillmentOrderId: ID!, reverseDeliveryLineItems: [ReverseDeliveryLineItemInput!]!, trackingInput: ReverseDeliveryTrackingInput, labelInput: ReverseDeliveryLabelInput, notifyCustomer: Boolean): ReverseDeliveryCreateWithShippingPayload
reverseDeliveryShippingUpdate(reverseDeliveryId: ID!, trackingInput: ReverseDeliveryTrackingInput, labelInput: ReverseDeliveryLabelInput, notifyCustomer: Boolean): ReverseDeliveryShippingUpdatePayload
reverseFulfillmentOrderDispose(dispositionInputs: [ReverseFulfillmentOrderDisposeInput!]!): ReverseFulfillmentOrderDisposePayload

## Mutations — saved (3 ops)

savedSearchCreate(input: SavedSearchCreateInput!): SavedSearchCreatePayload
savedSearchDelete(input: SavedSearchDeleteInput!): SavedSearchDeletePayload
savedSearchUpdate(input: SavedSearchUpdateInput!): SavedSearchUpdatePayload

## Mutations — script (3 ops)

scriptTagCreate(input: ScriptTagInput!): ScriptTagCreatePayload
scriptTagDelete(id: ID!): ScriptTagDeletePayload
scriptTagUpdate(id: ID!, input: ScriptTagInput!): ScriptTagUpdatePayload

## Mutations — segment (3 ops)

segmentCreate(name: String!, query: String!): SegmentCreatePayload
segmentDelete(id: ID!): SegmentDeletePayload
segmentUpdate(id: ID!, name: String, query: String): SegmentUpdatePayload

## Mutations — selling (7 ops)

sellingPlanGroupAddProductVariants(id: ID!, productVariantIds: [ID!]!): SellingPlanGroupAddProductVariantsPayload
sellingPlanGroupAddProducts(id: ID!, productIds: [ID!]!): SellingPlanGroupAddProductsPayload
sellingPlanGroupCreate(input: SellingPlanGroupInput!, resources: SellingPlanGroupResourceInput): SellingPlanGroupCreatePayload
sellingPlanGroupDelete(id: ID!): SellingPlanGroupDeletePayload
sellingPlanGroupRemoveProductVariants(id: ID!, productVariantIds: [ID!]!): SellingPlanGroupRemoveProductVariantsPayload
sellingPlanGroupRemoveProducts(id: ID!, productIds: [ID!]!): SellingPlanGroupRemoveProductsPayload
sellingPlanGroupUpdate(id: ID!, input: SellingPlanGroupInput!): SellingPlanGroupUpdatePayload

## Mutations — server (2 ops)

serverPixelCreate: ServerPixelCreatePayload
serverPixelDelete: ServerPixelDeletePayload

## Mutations — shipping (3 ops)

shippingPackageDelete(id: ID!): ShippingPackageDeletePayload
shippingPackageMakeDefault(id: ID!): ShippingPackageMakeDefaultPayload
shippingPackageUpdate(id: ID!, shippingPackage: CustomShippingPackageInput!): ShippingPackageUpdatePayload

## Mutations — shop (5 ops)

shopLocaleDisable(locale: String!): ShopLocaleDisablePayload
shopLocaleEnable(locale: String!, marketWebPresenceIds: [ID!]): ShopLocaleEnablePayload
shopLocaleUpdate(locale: String!, shopLocale: ShopLocaleInput!): ShopLocaleUpdatePayload
shopPolicyUpdate(shopPolicy: ShopPolicyInput!): ShopPolicyUpdatePayload
shopResourceFeedbackCreate(input: ResourceFeedbackCreateInput!): ShopResourceFeedbackCreatePayload

## Mutations — shopify (1 ops)

shopifyPaymentsPayoutAlternateCurrencyCreate(accountId: ID, currency: CurrencyCode!): ShopifyPaymentsPayoutAlternateCurrencyCreatePayload

## Mutations — staged (1 ops)

stagedUploadsCreate(input: [StagedUploadInput!]!): StagedUploadsCreatePayload

## Mutations — store (2 ops)

storeCreditAccountCredit(id: ID!, creditInput: StoreCreditAccountCreditInput!): StoreCreditAccountCreditPayload
storeCreditAccountDebit(id: ID!, debitInput: StoreCreditAccountDebitInput!): StoreCreditAccountDebitPayload

## Mutations — storefront (2 ops)

storefrontAccessTokenCreate(input: StorefrontAccessTokenInput!): StorefrontAccessTokenCreatePayload
storefrontAccessTokenDelete(input: StorefrontAccessTokenDeleteInput!): StorefrontAccessTokenDeletePayload

## Mutations — subscription (33 ops)

subscriptionBillingAttemptCreate(subscriptionContractId: ID!, subscriptionBillingAttemptInput: SubscriptionBillingAttemptInput!): SubscriptionBillingAttemptCreatePayload
subscriptionBillingCycleBulkCharge(billingAttemptExpectedDateRange: SubscriptionBillingCyclesDateRangeSelector!, filters: SubscriptionBillingCycleBulkFilters, inventoryPolicy: SubscriptionBillingAttemptInventoryPolicy, paymentProcessingPolicy: SubscriptionBillingAttemptPaymentProcessingPolicy): SubscriptionBillingCycleBulkChargePayload
subscriptionBillingCycleBulkSearch(billingAttemptExpectedDateRange: SubscriptionBillingCyclesDateRangeSelector!, filters: SubscriptionBillingCycleBulkFilters): SubscriptionBillingCycleBulkSearchPayload
subscriptionBillingCycleCharge(subscriptionContractId: ID!, billingCycleSelector: SubscriptionBillingCycleSelector!, inventoryPolicy: SubscriptionBillingAttemptInventoryPolicy, paymentProcessingPolicy: SubscriptionBillingAttemptPaymentProcessingPolicy): SubscriptionBillingCycleChargePayload
subscriptionBillingCycleContractDraftCommit(draftId: ID!): SubscriptionBillingCycleContractDraftCommitPayload
subscriptionBillingCycleContractDraftConcatenate(draftId: ID!, concatenatedBillingCycleContracts: [SubscriptionBillingCycleInput!]!): SubscriptionBillingCycleContractDraftConcatenatePayload
subscriptionBillingCycleContractEdit(billingCycleInput: SubscriptionBillingCycleInput!): SubscriptionBillingCycleContractEditPayload
subscriptionBillingCycleEditDelete(billingCycleInput: SubscriptionBillingCycleInput!): SubscriptionBillingCycleEditDeletePayload
subscriptionBillingCycleEditsDelete(contractId: ID!, targetSelection: SubscriptionBillingCyclesTargetSelection!): SubscriptionBillingCycleEditsDeletePayload
subscriptionBillingCycleScheduleEdit(billingCycleInput: SubscriptionBillingCycleInput!, input: SubscriptionBillingCycleScheduleEditInput!): SubscriptionBillingCycleScheduleEditPayload
subscriptionBillingCycleSkip(billingCycleInput: SubscriptionBillingCycleInput!): SubscriptionBillingCycleSkipPayload
subscriptionBillingCycleUnskip(billingCycleInput: SubscriptionBillingCycleInput!): SubscriptionBillingCycleUnskipPayload
subscriptionContractActivate(subscriptionContractId: ID!): SubscriptionContractActivatePayload
subscriptionContractAtomicCreate(input: SubscriptionContractAtomicCreateInput!): SubscriptionContractAtomicCreatePayload
subscriptionContractCancel(subscriptionContractId: ID!): SubscriptionContractCancelPayload
subscriptionContractCreate(input: SubscriptionContractCreateInput!): SubscriptionContractCreatePayload
subscriptionContractExpire(subscriptionContractId: ID!): SubscriptionContractExpirePayload
subscriptionContractFail(subscriptionContractId: ID!): SubscriptionContractFailPayload
subscriptionContractPause(subscriptionContractId: ID!): SubscriptionContractPausePayload
subscriptionContractProductChange(subscriptionContractId: ID!, lineId: ID!, input: SubscriptionContractProductChangeInput!): SubscriptionContractProductChangePayload
subscriptionContractSetNextBillingDate(contractId: ID!, date: DateTime!): SubscriptionContractSetNextBillingDatePayload
subscriptionContractUpdate(contractId: ID!): SubscriptionContractUpdatePayload
subscriptionDraftCommit(draftId: ID!): SubscriptionDraftCommitPayload
subscriptionDraftDiscountAdd(draftId: ID!, input: SubscriptionManualDiscountInput!): SubscriptionDraftDiscountAddPayload
subscriptionDraftDiscountCodeApply(draftId: ID!, redeemCode: String!): SubscriptionDraftDiscountCodeApplyPayload
subscriptionDraftDiscountRemove(draftId: ID!, discountId: ID!): SubscriptionDraftDiscountRemovePayload
subscriptionDraftDiscountUpdate(draftId: ID!, discountId: ID!, input: SubscriptionManualDiscountInput!): SubscriptionDraftDiscountUpdatePayload
subscriptionDraftFreeShippingDiscountAdd(draftId: ID!, input: SubscriptionFreeShippingDiscountInput!): SubscriptionDraftFreeShippingDiscountAddPayload
subscriptionDraftFreeShippingDiscountUpdate(draftId: ID!, discountId: ID!, input: SubscriptionFreeShippingDiscountInput!): SubscriptionDraftFreeShippingDiscountUpdatePayload
subscriptionDraftLineAdd(draftId: ID!, input: SubscriptionLineInput!): SubscriptionDraftLineAddPayload
subscriptionDraftLineRemove(draftId: ID!, lineId: ID!): SubscriptionDraftLineRemovePayload
subscriptionDraftLineUpdate(draftId: ID!, lineId: ID!, input: SubscriptionLineUpdateInput!): SubscriptionDraftLineUpdatePayload
subscriptionDraftUpdate(draftId: ID!, input: SubscriptionDraftInput!): SubscriptionDraftUpdatePayload

## Mutations — tags (2 ops)

tagsAdd(id: ID!, tags: [String!]!): TagsAddPayload
tagsRemove(id: ID!, tags: [String!]!): TagsRemovePayload

## Mutations — tax (2 ops)

taxAppConfigure(ready: Boolean!): TaxAppConfigurePayload
taxSummaryCreate(orderId: ID, startTime: DateTime, endTime: DateTime): TaxSummaryCreatePayload

## Mutations — theme (8 ops)

themeCreate(source: URL!, name: String, role: ThemeRole): ThemeCreatePayload
themeDelete(id: ID!): ThemeDeletePayload
themeDuplicate(id: ID!, name: String): ThemeDuplicatePayload
themeFilesCopy(themeId: ID!, files: [ThemeFilesCopyFileInput!]!): ThemeFilesCopyPayload
themeFilesDelete(themeId: ID!, files: [String!]!): ThemeFilesDeletePayload
themeFilesUpsert(themeId: ID!, files: [OnlineStoreThemeFilesUpsertFileInput!]!): ThemeFilesUpsertPayload
themePublish(id: ID!): ThemePublishPayload
themeUpdate(id: ID!, input: OnlineStoreThemeInput!): ThemeUpdatePayload

## Mutations — transaction (1 ops)

transactionVoid(parentTransactionId: ID!): TransactionVoidPayload

## Mutations — translations (2 ops)

translationsRegister(resourceId: ID!, translations: [TranslationInput!]!): TranslationsRegisterPayload
translationsRemove(resourceId: ID!, translationKeys: [String!]!, locales: [String!]!, marketIds: [ID!]): TranslationsRemovePayload

## Mutations — url (9 ops)

urlRedirectBulkDeleteAll: UrlRedirectBulkDeleteAllPayload
urlRedirectBulkDeleteByIds(ids: [ID!]!): UrlRedirectBulkDeleteByIdsPayload
urlRedirectBulkDeleteBySavedSearch(savedSearchId: ID!): UrlRedirectBulkDeleteBySavedSearchPayload
urlRedirectBulkDeleteBySearch(search: String!): UrlRedirectBulkDeleteBySearchPayload
urlRedirectCreate(urlRedirect: UrlRedirectInput!): UrlRedirectCreatePayload
urlRedirectDelete(id: ID!): UrlRedirectDeletePayload
urlRedirectImportCreate(url: URL!): UrlRedirectImportCreatePayload
urlRedirectImportSubmit(id: ID!): UrlRedirectImportSubmitPayload
urlRedirectUpdate(id: ID!, urlRedirect: UrlRedirectInput!): UrlRedirectUpdatePayload

## Mutations — validation (3 ops)

validationCreate(validation: ValidationCreateInput!): ValidationCreatePayload
validationDelete(id: ID!): ValidationDeletePayload
validationUpdate(validation: ValidationUpdateInput!, id: ID!): ValidationUpdatePayload

## Mutations — web (6 ops)

webPixelCreate(webPixel: WebPixelInput!): WebPixelCreatePayload
webPixelDelete(id: ID!): WebPixelDeletePayload
webPixelUpdate(id: ID!, webPixel: WebPixelInput!): WebPixelUpdatePayload
webPresenceCreate(input: WebPresenceCreateInput!): WebPresenceCreatePayload
webPresenceDelete(id: ID!): WebPresenceDeletePayload
webPresenceUpdate(id: ID!, input: WebPresenceUpdateInput!): WebPresenceUpdatePayload

## Mutations — webhook (3 ops)

webhookSubscriptionCreate(topic: WebhookSubscriptionTopic!, webhookSubscription: WebhookSubscriptionInput!): WebhookSubscriptionCreatePayload
webhookSubscriptionDelete(id: ID!): WebhookSubscriptionDeletePayload
webhookSubscriptionUpdate(id: ID!, webhookSubscription: WebhookSubscriptionInput!): WebhookSubscriptionUpdatePayload
