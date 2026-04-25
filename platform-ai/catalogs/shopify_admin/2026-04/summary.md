# Shopify Admin GraphQL — 2026-04

Operation index for handler-prompt injection. Pick from the operations below — anything not listed is not in the schema and will fail offline validation. Full SDL with field-level shapes lives at catalogs/shopify_admin/2026-04/schema.graphql.

## Queries — 268 ops

abandonedCheckouts(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: AbandonedCheckoutSortKeys, query: String, savedSearchId: ID): AbandonedCheckoutConnection!
abandonedCheckoutsCount(query: String, savedSearchId: ID, limit: Int): Count
abandonment(id: ID!): Abandonment
abandonmentByAbandonedCheckoutId(abandonedCheckoutId: ID!): Abandonment
app(id: ID): App
appByHandle(handle: String!): App
appByKey(apiKey: String!): App
appDiscountType(functionId: String!): AppDiscountType
appDiscountTypes: [AppDiscountType!]!
appDiscountTypesNodes(first: Int, after: String, last: Int, before: String, reverse: Boolean): AppDiscountTypeConnection!
appInstallation(id: ID): AppInstallation
appInstallations(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: AppInstallationSortKeys, category: AppInstallationCategory, privacy: AppInstallationPrivacy): AppInstallationConnection!
article(id: ID!): Article
articleAuthors(first: Int, after: String, last: Int, before: String, reverse: Boolean): ArticleAuthorConnection!
articleTags(sort: ArticleTagSort, limit: Int!): [String!]!
articles(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: ArticleSortKeys, query: String): ArticleConnection!
assignedFulfillmentOrders(assignmentStatus: FulfillmentOrderAssignmentStatus, locationIds: [ID!], first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: FulfillmentOrderSortKeys): FulfillmentOrderConnection!
automaticDiscountNode(id: ID!): DiscountAutomaticNode
automaticDiscountSavedSearches(first: Int, after: String, last: Int, before: String, reverse: Boolean): SavedSearchConnection!
availableBackupRegions: [MarketRegion!]!
availableCarrierServices: [DeliveryCarrierServiceAndLocations!]!
availableLocales: [Locale!]!
backupRegion: MarketRegion!
blog(id: ID!): Blog
blogs(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: BlogSortKeys, query: String): BlogConnection!
blogsCount(query: String, limit: Int): Count
bulkOperation(id: ID!): BulkOperation
bulkOperations(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: BulkOperationsSortKeys, query: String): BulkOperationConnection!
businessEntities: [BusinessEntity!]!
businessEntity(id: ID): BusinessEntity
carrierService(id: ID!): DeliveryCarrierService
carrierServices(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: CarrierServiceSortKeys, query: String): DeliveryCarrierServiceConnection!
cartTransforms(first: Int, after: String, last: Int, before: String, reverse: Boolean): CartTransformConnection!
cashDrawer(id: ID!): CashDrawer
cashDrawers(first: Int, after: String, last: Int, before: String, query: String): CashDrawerConnection!
cashManagementLocationSummary(locationId: ID!, startDate: Date!, endDate: Date!): CashManagementSummary!
cashManagementReasonCodes(first: Int, after: String, last: Int, before: String, reverse: Boolean): CashManagementReasonCodeConnection!
cashManagementShopSummary(currencyCode: CurrencyCode!, startDate: Date!, endDate: Date!): CashManagementSummary!
cashTrackingSession(id: ID!): CashTrackingSession
cashTrackingSessions(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: CashTrackingSessionsSortKeys, query: String): CashTrackingSessionConnection!
catalog(id: ID!): Catalog
catalogOperations: [ResourceOperation!]!
catalogs(type: CatalogType, first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: CatalogSortKeys, query: String): CatalogConnection!
catalogsCount(type: CatalogType, query: String, limit: Int): Count
channel(id: ID!): Channel
channelByHandle(handle: String!): Channel
channels(first: Int, after: String, last: Int, before: String, reverse: Boolean): ChannelConnection!
checkoutAndAccountsConfiguration(id: ID!): CheckoutAndAccountsConfiguration
checkoutAndAccountsConfigurations(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: CheckoutAndAccountsConfigurationsGraphQLSortKeys, query: String): CheckoutAndAccountsConfigurationConnection
codeDiscountNode(id: ID!): DiscountCodeNode
codeDiscountNodeByCode(code: String!): DiscountCodeNode
codeDiscountSavedSearches(first: Int, after: String, last: Int, before: String, reverse: Boolean): SavedSearchConnection!
collection(id: ID!): Collection
collectionByIdentifier(identifier: CollectionIdentifierInput!): Collection
collectionRulesConditions: [CollectionRuleConditions!]!
collectionSavedSearches(first: Int, after: String, last: Int, before: String, reverse: Boolean): SavedSearchConnection!
collections(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: CollectionSortKeys, query: String, savedSearchId: ID): CollectionConnection!
collectionsCount(query: String, savedSearchId: ID, limit: Int): Count
comment(id: ID!): Comment
comments(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: CommentSortKeys, query: String): CommentConnection!
companies(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: CompanySortKeys, query: String): CompanyConnection!
companiesCount(limit: Int): Count
company(id: ID!): Company
companyContact(id: ID!): CompanyContact
companyContactRole(id: ID!): CompanyContactRole
companyLocation(id: ID!): CompanyLocation
companyLocations(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: CompanyLocationSortKeys, query: String): CompanyLocationConnection!
consentPolicy(id: ID, countryCode: PrivacyCountryCode, regionCode: String, consentRequired: Boolean, dataSaleOptOutRequired: Boolean): [ConsentPolicy!]!
consentPolicyRegions: [ConsentPolicyRegion!]!
currentAppInstallation: AppInstallation!
currentStaffMember: StaffMember
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
customers(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: CustomerSortKeys, query: String): CustomerConnection!
customersCount(query: String, limit: Int): Count
deliveryCustomization(id: ID!): DeliveryCustomization
deliveryCustomizations(first: Int, after: String, last: Int, before: String, reverse: Boolean, query: String): DeliveryCustomizationConnection!
deliveryProfile(id: ID!): DeliveryProfile
deliveryProfiles(merchantOwnedOnly: Boolean, first: Int, after: String, last: Int, before: String, reverse: Boolean): DeliveryProfileConnection!
deliveryPromiseParticipants(ownerIds: [ID!], brandedPromiseHandle: String!, first: Int, after: String, last: Int, before: String, reverse: Boolean): DeliveryPromiseParticipantConnection
deliveryPromiseProvider(locationId: ID!): DeliveryPromiseProvider
deliveryPromiseSettings: DeliveryPromiseSetting!
discountCodesCount(query: String, limit: Int): Count
discountNode(id: ID!): DiscountNode
discountNodes(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: DiscountSortKeys, query: String, savedSearchId: ID): DiscountNodeConnection!
discountNodesCount(query: String, savedSearchId: ID, limit: Int): Count
discountRedeemCodeBulkCreation(id: ID!): DiscountRedeemCodeBulkCreation
discountRedeemCodeSavedSearches(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: DiscountCodeSortKeys, query: String): SavedSearchConnection!
discountTags(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: DiscountTagSortKeys, query: String): StringConnection!
dispute(id: ID!): ShopifyPaymentsDispute
disputeEvidence(id: ID!): ShopifyPaymentsDisputeEvidence
disputes(first: Int, after: String, last: Int, before: String, reverse: Boolean, query: String): ShopifyPaymentsDisputeConnection!
domain(id: ID!): Domain
draftOrder(id: ID!): DraftOrder
draftOrderAvailableDeliveryOptions(input: DraftOrderAvailableDeliveryOptionsInput!, search: String, localPickupFrom: Int, localPickupCount: Int, sessionToken: String): DraftOrderAvailableDeliveryOptions!
draftOrderSavedSearches(first: Int, after: String, last: Int, before: String, reverse: Boolean): SavedSearchConnection!
draftOrderTag(id: ID!): DraftOrderTag
draftOrders(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: DraftOrderSortKeys, query: String, savedSearchId: ID): DraftOrderConnection!
draftOrdersCount(query: String, savedSearchId: ID, limit: Int): Count
event(id: ID!): Event
events(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: EventSortKeys, query: String): EventConnection
eventsCount(query: String): Count
fileSavedSearches(first: Int, after: String, last: Int, before: String, reverse: Boolean): SavedSearchConnection!
files(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: FileSortKeys, query: String, savedSearchId: ID): FileConnection!
financeAppAccessPolicy: FinanceAppAccessPolicy!
financeKycInformation: FinanceKycInformation
fulfillment(id: ID!): Fulfillment
fulfillmentConstraintRules: [FulfillmentConstraintRule!]!
fulfillmentOrder(id: ID!): FulfillmentOrder
fulfillmentOrders(includeClosed: Boolean, first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: FulfillmentOrderSortKeys, query: String): FulfillmentOrderConnection!
fulfillmentService(id: ID!): FulfillmentService
giftCard(id: ID!): GiftCard
giftCardConfiguration: GiftCardConfiguration!
giftCards(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: GiftCardSortKeys, query: String, savedSearchId: ID): GiftCardConnection!
giftCardsCount(query: String, savedSearchId: ID, limit: Int): Count
inventoryItem(id: ID!): InventoryItem
inventoryItems(first: Int, after: String, last: Int, before: String, reverse: Boolean, query: String): InventoryItemConnection!
inventoryLevel(id: ID!): InventoryLevel
inventoryProperties: InventoryProperties!
inventoryShipment(id: ID!): InventoryShipment
inventoryShipments(first: Int, after: String, last: Int, before: String, sortKey: InventoryShipmentSortKeys, query: String): InventoryShipmentConnection
inventoryTransfer(id: ID!): InventoryTransfer
inventoryTransfers(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: TransferSortKeys, query: String, savedSearchId: ID): InventoryTransferConnection!
job(id: ID!): Job
location(id: ID): Location
locationByIdentifier(identifier: LocationIdentifierInput!): Location
locations(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: LocationSortKeys, query: String, includeLegacy: Boolean, includeInactive: Boolean): LocationConnection!
locationsAvailableForDeliveryProfilesConnection(first: Int, after: String, last: Int, before: String, reverse: Boolean): LocationConnection!
locationsCount(query: String, limit: Int): Count
manualHoldsFulfillmentOrders(query: String, first: Int, after: String, last: Int, before: String, reverse: Boolean): FulfillmentOrderConnection!
market(id: ID!): Market
marketLocalizableResource(resourceId: ID!): MarketLocalizableResource
marketLocalizableResources(resourceType: MarketLocalizableResourceType!, first: Int, after: String, last: Int, before: String, reverse: Boolean): MarketLocalizableResourceConnection!
marketLocalizableResourcesByIds(resourceIds: [ID!]!, first: Int, after: String, last: Int, before: String, reverse: Boolean): MarketLocalizableResourceConnection!
marketingActivities(marketingActivityIds: [ID!], remoteIds: [String!], utm: UTMInput, first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: MarketingActivitySortKeys, query: String, savedSearchId: ID): MarketingActivityConnection!
marketingActivity(id: ID!): MarketingActivity
marketingEvent(id: ID!): MarketingEvent
marketingEvents(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: MarketingEventSortKeys, query: String): MarketingEventConnection!
markets(type: MarketType, first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: MarketsSortKeys, query: String): MarketConnection!
marketsResolvedValues(buyerSignal: BuyerSignalInput!): MarketsResolvedValues!
menu(id: ID!): Menu
menus(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: MenuSortKeys, query: String): MenuConnection!
metafieldDefinition(identifier: MetafieldDefinitionIdentifierInput): MetafieldDefinition
metafieldDefinitionTypes: [MetafieldDefinitionType!]!
metafieldDefinitions(key: String, namespace: String, ownerType: MetafieldOwnerType!, pinnedStatus: MetafieldDefinitionPinnedStatus, constraintSubtype: MetafieldDefinitionConstraintSubtypeIdentifier, constraintStatus: MetafieldDefinitionConstraintStatus, first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: MetafieldDefinitionSortKeys, query: String): MetafieldDefinitionConnection!
metaobject(id: ID!): Metaobject
metaobjectByHandle(handle: MetaobjectHandleInput!): Metaobject
metaobjectDefinition(id: ID!): MetaobjectDefinition
metaobjectDefinitionByType(type: String!): MetaobjectDefinition
metaobjectDefinitions(first: Int, after: String, last: Int, before: String, reverse: Boolean): MetaobjectDefinitionConnection!
metaobjects(type: String!, sortKey: String, first: Int, after: String, last: Int, before: String, reverse: Boolean, query: String): MetaobjectConnection!
mobilePlatformApplication(id: ID!): MobilePlatformApplication
mobilePlatformApplications(first: Int, after: String, last: Int, before: String, reverse: Boolean): MobilePlatformApplicationConnection!
node(id: ID!): Node
nodes(ids: [ID!]!): [Node]!
onlineStore: OnlineStore!
order(id: ID!): Order
orderByIdentifier(identifier: OrderIdentifierInput!): Order
orderEditSession(id: ID!): OrderEditSession
orderPaymentStatus(paymentReferenceId: String!, orderId: ID!): OrderPaymentStatus
orderSavedSearches(first: Int, after: String, last: Int, before: String, reverse: Boolean): SavedSearchConnection!
orders(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: OrderSortKeys, query: String, savedSearchId: ID): OrderConnection!
ordersCount(query: String, savedSearchId: ID, limit: Int): Count
page(id: ID!): Page
pages(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: PageSortKeys, query: String, savedSearchId: ID): PageConnection!
pagesCount(limit: Int): Count
paymentCustomization(id: ID!): PaymentCustomization
paymentCustomizations(first: Int, after: String, last: Int, before: String, reverse: Boolean, query: String): PaymentCustomizationConnection!
paymentTermsTemplates(paymentTermsType: PaymentTermsType): [PaymentTermsTemplate!]!
pendingOrdersCount: Count
pointOfSaleDevice(id: ID!): PointOfSaleDevice
pointOfSaleDevicePaymentSession(id: ID!): PointOfSaleDevicePaymentSession
pointOfSaleDevicePaymentSessions(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: PointOfSaleDevicePaymentSessionSortKeys, query: String): PointOfSaleDevicePaymentSessionConnection!
priceList(id: ID!): PriceList
priceLists(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: PriceListSortKeys): PriceListConnection!
privacySettings: PrivacySettings!
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
products(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: ProductSortKeys, query: String, savedSearchId: ID): ProductConnection!
productsCount(query: String, savedSearchId: ID, limit: Int): Count
publicApiVersions: [ApiVersion!]!
publication(id: ID!): Publication
publications(catalogType: CatalogType, first: Int, after: String, last: Int, before: String, reverse: Boolean): PublicationConnection!
publicationsCount(catalogType: CatalogType, limit: Int): Count
publishedProductsCount(publicationId: ID!, limit: Int): Count
refund(id: ID!): Refund
return(id: ID!): Return
returnCalculate(input: CalculateReturnInput!): CalculatedReturn
returnReasonDefinitions(ids: [ID!], handles: [String!], first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: ReturnReasonDefinitionSortKeys, query: String): ReturnReasonDefinitionConnection!
returnableFulfillment(id: ID!): ReturnableFulfillment
returnableFulfillments(orderId: ID!, first: Int, after: String, last: Int, before: String, reverse: Boolean): ReturnableFulfillmentConnection!
reverseDelivery(id: ID!): ReverseDelivery
reverseFulfillmentOrder(id: ID!): ReverseFulfillmentOrder
scriptTag(id: ID!): ScriptTag
scriptTags(first: Int, after: String, last: Int, before: String, reverse: Boolean, query: String, src: URL): ScriptTagConnection!
segment(id: ID!): Segment
segmentFilterSuggestions(search: String!, first: Int!, after: String): SegmentFilterConnection!
segmentFilters(first: Int, after: String, last: Int, before: String): SegmentFilterConnection!
segmentMigrations(savedSearchId: ID, first: Int, after: String, last: Int, before: String): SegmentMigrationConnection!
segmentValueSuggestions(search: String!, filterQueryName: String, functionParameterQueryName: String, first: Int, after: String, last: Int, before: String): SegmentValueConnection!
segments(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: SegmentSortKeys, query: String): SegmentConnection!
segmentsCount(limit: Int): Count
sellingPlanGroup(id: ID!): SellingPlanGroup
sellingPlanGroups(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: SellingPlanGroupSortKeys, query: String): SellingPlanGroupConnection!
serverPixel: ServerPixel
shop: Shop!
shopBillingPreferences: ShopBillingPreferences!
shopLocales(published: Boolean): [ShopLocale!]!
shopPayPaymentRequestReceipt(token: String!): ShopPayPaymentRequestReceipt
shopPayPaymentRequestReceipts(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: ShopPayPaymentRequestReceiptsSortKeys, query: String): ShopPayPaymentRequestReceiptConnection
shopifyFunction(id: String!): ShopifyFunction
shopifyFunctions(apiType: String, useCreationUi: Boolean, first: Int, after: String, last: Int, before: String, reverse: Boolean): ShopifyFunctionConnection!
shopifyPaymentsAccount: ShopifyPaymentsAccount
shopifyqlQuery(query: String!): ShopifyqlQueryResponse
staffMember(id: ID): StaffMember
staffMembers(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: StaffMembersSortKeys, query: String): StaffMemberConnection
standardMetafieldDefinitionTemplates(constraintSubtype: MetafieldDefinitionConstraintSubtypeIdentifier, constraintStatus: MetafieldDefinitionConstraintStatus, excludeActivated: Boolean, first: Int, after: String, last: Int, before: String, reverse: Boolean): StandardMetafieldDefinitionTemplateConnection!
storeCreditAccount(id: ID!): StoreCreditAccount
storeCreditConfiguration: StoreCreditConfiguration!
subscriptionBillingAttempt(id: ID!): SubscriptionBillingAttempt
subscriptionBillingAttempts(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: SubscriptionBillingAttemptsSortKeys, query: String): SubscriptionBillingAttemptConnection!
subscriptionBillingCycle(billingCycleInput: SubscriptionBillingCycleInput!): SubscriptionBillingCycle
subscriptionBillingCycleBulkResults(jobId: ID!, first: Int, after: String, last: Int, before: String, reverse: Boolean): SubscriptionBillingCycleConnection!
subscriptionBillingCycles(contractId: ID!, billingCyclesDateRangeSelector: SubscriptionBillingCyclesDateRangeSelector, billingCyclesIndexRangeSelector: SubscriptionBillingCyclesIndexRangeSelector, first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: SubscriptionBillingCyclesSortKeys): SubscriptionBillingCycleConnection!
subscriptionContract(id: ID!): SubscriptionContract
subscriptionContracts(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: SubscriptionContractsSortKeys, query: String): SubscriptionContractConnection!
subscriptionDraft(id: ID!): SubscriptionDraft
taxonomy: Taxonomy
tenderTransactions(first: Int, after: String, last: Int, before: String, reverse: Boolean, query: String): TenderTransactionConnection!
theme(id: ID!): OnlineStoreTheme
themes(roles: [ThemeRole!], names: [String!], first: Int, after: String, last: Int, before: String, reverse: Boolean): OnlineStoreThemeConnection
translatableResource(resourceId: ID!): TranslatableResource
translatableResources(resourceType: TranslatableResourceType!, first: Int, after: String, last: Int, before: String, reverse: Boolean): TranslatableResourceConnection!
translatableResourcesByIds(resourceIds: [ID!]!, first: Int, after: String, last: Int, before: String, reverse: Boolean): TranslatableResourceConnection!
urlRedirect(id: ID!): UrlRedirect
urlRedirectImport(id: ID!): UrlRedirectImport
urlRedirectSavedSearches(first: Int, after: String, last: Int, before: String, reverse: Boolean): SavedSearchConnection!
urlRedirects(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: UrlRedirectSortKeys, query: String, savedSearchId: ID): UrlRedirectConnection!
urlRedirectsCount(query: String, savedSearchId: ID, limit: Int): Count
validation(id: ID!): Validation
validations(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: ValidationSortKeys): ValidationConnection!
webPixel(id: ID): WebPixel
webPresences(first: Int, after: String, last: Int, before: String, reverse: Boolean): MarketWebPresenceConnection
webhookSubscription(id: ID!): WebhookSubscription
webhookSubscriptions(first: Int, after: String, last: Int, before: String, reverse: Boolean, sortKey: WebhookSubscriptionSortKeys, query: String, uri: String, format: WebhookSubscriptionFormat, topics: [WebhookSubscriptionTopic!]): WebhookSubscriptionConnection!
webhookSubscriptionsCount(query: String, limit: Int): Count

## Mutations — 477 ops

abandonmentUpdateActivitiesDeliveryStatuses(abandonmentId: ID!, marketingActivityId: ID!, deliveryStatus: AbandonmentDeliveryState!, deliveredAt: DateTime, deliveryStatusChangeReason: String): AbandonmentUpdateActivitiesDeliveryStatusesPayload
appPurchaseOneTimeCreate(name: String!, price: MoneyInput!, returnUrl: URL!, test: Boolean): AppPurchaseOneTimeCreatePayload
appRevokeAccessScopes(scopes: [String!]!): AppRevokeAccessScopesPayload
appSubscriptionCancel(id: ID!, prorate: Boolean): AppSubscriptionCancelPayload
appSubscriptionCreate(name: String!, lineItems: [AppSubscriptionLineItemInput!]!, test: Boolean, trialDays: Int, returnUrl: URL!, replacementBehavior: AppSubscriptionReplacementBehavior): AppSubscriptionCreatePayload
appSubscriptionLineItemUpdate(id: ID!, cappedAmount: MoneyInput!): AppSubscriptionLineItemUpdatePayload
appSubscriptionTrialExtend(id: ID!, days: Int!): AppSubscriptionTrialExtendPayload
appUninstall: AppUninstallPayload
appUsageRecordCreate(subscriptionLineItemId: ID!, price: MoneyInput!, description: String!, idempotencyKey: String): AppUsageRecordCreatePayload
articleCreate(article: ArticleCreateInput!, blog: ArticleBlogInput): ArticleCreatePayload
articleDelete(id: ID!): ArticleDeletePayload
articleUpdate(id: ID!, article: ArticleUpdateInput!, blog: ArticleBlogInput): ArticleUpdatePayload
backupRegionUpdate(region: BackupRegionUpdateInput): BackupRegionUpdatePayload
blogCreate(blog: BlogCreateInput!): BlogCreatePayload
blogDelete(id: ID!): BlogDeletePayload
blogUpdate(id: ID!, blog: BlogUpdateInput!): BlogUpdatePayload
bulkOperationCancel(id: ID!): BulkOperationCancelPayload
bulkOperationRunMutation(mutation: String!, stagedUploadPath: String!, clientIdentifier: String): BulkOperationRunMutationPayload
bulkOperationRunQuery(query: String!, groupObjects: Boolean!): BulkOperationRunQueryPayload
bulkProductResourceFeedbackCreate(feedbackInput: [ProductResourceFeedbackInput!]!): BulkProductResourceFeedbackCreatePayload
carrierServiceCreate(input: DeliveryCarrierServiceCreateInput!): CarrierServiceCreatePayload
carrierServiceDelete(id: ID!): CarrierServiceDeletePayload
carrierServiceUpdate(input: DeliveryCarrierServiceUpdateInput!): CarrierServiceUpdatePayload
cartTransformCreate(functionHandle: String, blockOnFailure: Boolean, metafields: [MetafieldInput!]): CartTransformCreatePayload
cartTransformDelete(id: ID!): CartTransformDeletePayload
cashDrawerCreate(locationId: ID!, name: String!): CashDrawerCreatePayload
cashDrawerFindOrCreate(locationId: ID!, name: String!, pointOfSaleDeviceId: ID!): CashDrawerFindOrCreatePayload
cashDrawerUpdate(id: ID!, input: CashDrawerUpdateInput!): CashDrawerUpdatePayload
cashManagementReasonCodeCreate(code: String!): CashManagementReasonCodeCreatePayload
cashManagementReasonCodeDelete(id: ID!): CashManagementReasonCodeDeletePayload
catalogContextUpdate(catalogId: ID!, contextsToAdd: CatalogContextInput, contextsToRemove: CatalogContextInput): CatalogContextUpdatePayload
catalogCreate(input: CatalogCreateInput!): CatalogCreatePayload
catalogDelete(id: ID!, deleteDependentResources: Boolean): CatalogDeletePayload
catalogUpdate(id: ID!, input: CatalogUpdateInput!): CatalogUpdatePayload
channelCreate(input: ChannelCreateInput!): ChannelCreatePayload
channelDelete(id: ID!): ChannelDeletePayload
channelFullSync(channelId: ID!, language: LanguageCode, country: CountryCode, beforeUpdatedAt: DateTime, updatedAtSince: DateTime): ChannelFullSyncPayload
channelUpdate(id: ID!, input: ChannelUpdateInput!): ChannelUpdatePayload
checkoutAndAccountsConfigurationUpdate(id: ID!, configuration: CheckoutAndAccountsConfigurationInput!): CheckoutAndAccountsConfigurationUpdatePayload
collectionAddProducts(id: ID!, productIds: [ID!]!): CollectionAddProductsPayload
collectionAddProductsV2(id: ID!, productIds: [ID!]!): CollectionAddProductsV2Payload
collectionCreate(input: CollectionInput!): CollectionCreatePayload
collectionDelete(input: CollectionDeleteInput!): CollectionDeletePayload
collectionDuplicate(input: CollectionDuplicateInput!): CollectionDuplicatePayload
collectionRemoveProducts(id: ID!, productIds: [ID!]!): CollectionRemoveProductsPayload
collectionReorderProducts(id: ID!, moves: [MoveInput!]!): CollectionReorderProductsPayload
collectionUpdate(input: CollectionInput!): CollectionUpdatePayload
combinedListingUpdate(parentProductId: ID!, title: String, productsAdded: [ChildProductRelationInput!], productsEdited: [ChildProductRelationInput!], productsRemovedIds: [ID!], optionsAndValues: [OptionAndValueInput!]): CombinedListingUpdatePayload
commentApprove(id: ID!): CommentApprovePayload
commentDelete(id: ID!): CommentDeletePayload
commentNotSpam(id: ID!): CommentNotSpamPayload
commentSpam(id: ID!): CommentSpamPayload
companiesDelete(companyIds: [ID!]!): CompaniesDeletePayload
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
consentPolicyUpdate(consentPolicies: [ConsentPolicyInput!]!): ConsentPolicyUpdatePayload
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
dataSaleOptOut(email: String!): DataSaleOptOutPayload
delegateAccessTokenCreate(input: DelegateAccessTokenInput!): DelegateAccessTokenCreatePayload
delegateAccessTokenDestroy(accessToken: String!): DelegateAccessTokenDestroyPayload
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
disputeEvidenceUpdate(id: ID!, input: ShopifyPaymentsDisputeEvidenceUpdateInput!): DisputeEvidenceUpdatePayload
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
eventBridgeServerPixelUpdate(arn: ARN!): EventBridgeServerPixelUpdatePayload
fileAcknowledgeUpdateFailed(fileIds: [ID!]!): FileAcknowledgeUpdateFailedPayload
fileCreate(files: [FileCreateInput!]!): FileCreatePayload
fileDelete(fileIds: [ID!]!): FileDeletePayload
fileUpdate(files: [FileUpdateInput!]!): FileUpdatePayload
flowGenerateSignature(id: ID!, payload: String!): FlowGenerateSignaturePayload
flowTriggerReceive(handle: String, payload: JSON): FlowTriggerReceivePayload
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
giftCardCreate(input: GiftCardCreateInput!): GiftCardCreatePayload
giftCardCredit(id: ID!, creditInput: GiftCardCreditInput!): GiftCardCreditPayload
giftCardDeactivate(id: ID!): GiftCardDeactivatePayload
giftCardDebit(id: ID!, debitInput: GiftCardDebitInput!): GiftCardDebitPayload
giftCardSendNotificationToCustomer(id: ID!): GiftCardSendNotificationToCustomerPayload
giftCardSendNotificationToRecipient(id: ID!): GiftCardSendNotificationToRecipientPayload
giftCardUpdate(id: ID!, input: GiftCardUpdateInput!): GiftCardUpdatePayload
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
locationActivate(locationId: ID!): LocationActivatePayload
locationAdd(input: LocationAddInput!): LocationAddPayload
locationDeactivate(locationId: ID!, destinationLocationId: ID): LocationDeactivatePayload
locationDelete(locationId: ID!): LocationDeletePayload
locationEdit(id: ID!, input: LocationEditInput!): LocationEditPayload
locationLocalPickupDisable(locationId: ID!): LocationLocalPickupDisablePayload
locationLocalPickupEnable(localPickupSettings: DeliveryLocationLocalPickupEnableInput!): LocationLocalPickupEnablePayload
marketCreate(input: MarketCreateInput!): MarketCreatePayload
marketDelete(id: ID!): MarketDeletePayload
marketLocalizationsRegister(resourceId: ID!, marketLocalizations: [MarketLocalizationRegisterInput!]!): MarketLocalizationsRegisterPayload
marketLocalizationsRemove(resourceId: ID!, marketLocalizationKeys: [String!]!, marketIds: [ID!]!): MarketLocalizationsRemovePayload
marketUpdate(id: ID!, input: MarketUpdateInput!): MarketUpdatePayload
marketingActivitiesDeleteAllExternal: MarketingActivitiesDeleteAllExternalPayload
marketingActivityCreate(input: MarketingActivityCreateInput!): MarketingActivityCreatePayload
marketingActivityCreateExternal(input: MarketingActivityCreateExternalInput!): MarketingActivityCreateExternalPayload
marketingActivityDeleteExternal(marketingActivityId: ID, remoteId: String): MarketingActivityDeleteExternalPayload
marketingActivityUpdate(input: MarketingActivityUpdateInput!): MarketingActivityUpdatePayload
marketingActivityUpdateExternal(input: MarketingActivityUpdateExternalInput!, marketingActivityId: ID, remoteId: String, utm: UTMInput): MarketingActivityUpdateExternalPayload
marketingActivityUpsertExternal(input: MarketingActivityUpsertExternalInput!): MarketingActivityUpsertExternalPayload
marketingEngagementCreate(marketingActivityId: ID, remoteId: String, channelHandle: String, marketingEngagement: MarketingEngagementInput!): MarketingEngagementCreatePayload
marketingEngagementsDelete(channelHandle: String, deleteEngagementsForAllChannels: Boolean): MarketingEngagementsDeletePayload
menuCreate(title: String!, handle: String!, items: [MenuItemCreateInput!]!): MenuCreatePayload
menuDelete(id: ID!): MenuDeletePayload
menuUpdate(id: ID!, title: String!, handle: String, items: [MenuItemUpdateInput!]!): MenuUpdatePayload
metafieldDefinitionCreate(definition: MetafieldDefinitionInput!): MetafieldDefinitionCreatePayload
metafieldDefinitionDelete(id: ID, identifier: MetafieldDefinitionIdentifierInput, deleteAllAssociatedMetafields: Boolean): MetafieldDefinitionDeletePayload
metafieldDefinitionPin(definitionId: ID, identifier: MetafieldDefinitionIdentifierInput): MetafieldDefinitionPinPayload
metafieldDefinitionUnpin(definitionId: ID, identifier: MetafieldDefinitionIdentifierInput): MetafieldDefinitionUnpinPayload
metafieldDefinitionUpdate(definition: MetafieldDefinitionUpdateInput!): MetafieldDefinitionUpdatePayload
metafieldsDelete(metafields: [MetafieldIdentifierInput!]!): MetafieldsDeletePayload
metafieldsSet(metafields: [MetafieldsSetInput!]!): MetafieldsSetPayload
metaobjectBulkDelete(where: MetaobjectBulkDeleteWhereCondition!): MetaobjectBulkDeletePayload
metaobjectCreate(metaobject: MetaobjectCreateInput!): MetaobjectCreatePayload
metaobjectDefinitionCreate(definition: MetaobjectDefinitionCreateInput!): MetaobjectDefinitionCreatePayload
metaobjectDefinitionDelete(id: ID!): MetaobjectDefinitionDeletePayload
metaobjectDefinitionUpdate(id: ID!, definition: MetaobjectDefinitionUpdateInput!): MetaobjectDefinitionUpdatePayload
metaobjectDelete(id: ID!): MetaobjectDeletePayload
metaobjectUpdate(id: ID!, metaobject: MetaobjectUpdateInput!): MetaobjectUpdatePayload
metaobjectUpsert(handle: MetaobjectHandleInput!, metaobject: MetaobjectUpsertInput!): MetaobjectUpsertPayload
mobilePlatformApplicationCreate(input: MobilePlatformApplicationCreateInput!): MobilePlatformApplicationCreatePayload
mobilePlatformApplicationDelete(id: ID!): MobilePlatformApplicationDeletePayload
mobilePlatformApplicationUpdate(id: ID!, input: MobilePlatformApplicationUpdateInput!): MobilePlatformApplicationUpdatePayload
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
pageCreate(page: PageCreateInput!): PageCreatePayload
pageDelete(id: ID!): PageDeletePayload
pageUpdate(id: ID!, page: PageUpdateInput!): PageUpdatePayload
paymentCustomizationActivation(ids: [ID!]!, enabled: Boolean!): PaymentCustomizationActivationPayload
paymentCustomizationCreate(paymentCustomization: PaymentCustomizationInput!): PaymentCustomizationCreatePayload
paymentCustomizationDelete(id: ID!): PaymentCustomizationDeletePayload
paymentCustomizationUpdate(id: ID!, paymentCustomization: PaymentCustomizationInput!): PaymentCustomizationUpdatePayload
paymentReminderSend(paymentScheduleId: ID!): PaymentReminderSendPayload
paymentTermsCreate(referenceId: ID!, paymentTermsAttributes: PaymentTermsCreateInput!): PaymentTermsCreatePayload
paymentTermsDelete(input: PaymentTermsDeleteInput!): PaymentTermsDeletePayload
paymentTermsUpdate(input: PaymentTermsUpdateInput!): PaymentTermsUpdatePayload
pointOfSaleDeviceAssignToCashDrawer(cashDrawerId: ID!, pointOfSaleDeviceId: ID!): PointOfSaleDeviceAssignToCashDrawerPayload
pointOfSaleDevicePaymentSessionAdjust(pointOfSaleDevicePaymentSessionId: ID!, cash: MoneyInput!, staffMemberId: ID!, reasonCodeId: ID, note: String, time: DateTime): PointOfSaleDevicePaymentSessionAdjustPayload
pointOfSaleDevicePaymentSessionClose(pointOfSaleDevicePaymentSessionId: ID!, balance: MoneyInput!, staffMemberId: ID!, time: DateTime, reasonCodeId: ID, note: String): PointOfSaleDevicePaymentSessionClosePayload
pointOfSaleDevicePaymentSessionCount(pointOfSaleDevicePaymentSessionId: ID!, balance: MoneyInput!, staffMemberId: ID!, time: DateTime, reasonCodeId: ID, note: String): PointOfSaleDevicePaymentSessionCountPayload
pointOfSaleDevicePaymentSessionOpen(pointOfSaleDeviceId: ID!, balance: MoneyInput, staffMemberId: ID!, time: DateTime, reasonCodeId: ID, note: String): PointOfSaleDevicePaymentSessionOpenPayload
priceListCreate(input: PriceListCreateInput!): PriceListCreatePayload
priceListDelete(id: ID!): PriceListDeletePayload
priceListFixedPricesAdd(priceListId: ID!, prices: [PriceListPriceInput!]!): PriceListFixedPricesAddPayload
priceListFixedPricesByProductUpdate(pricesToAdd: [PriceListProductPriceInput!], pricesToDeleteByProductIds: [ID!], priceListId: ID!): PriceListFixedPricesByProductUpdatePayload
priceListFixedPricesDelete(priceListId: ID!, variantIds: [ID!]!): PriceListFixedPricesDeletePayload
priceListFixedPricesUpdate(priceListId: ID!, pricesToAdd: [PriceListPriceInput!]!, variantIdsToDelete: [ID!]!): PriceListFixedPricesUpdatePayload
priceListUpdate(id: ID!, input: PriceListUpdateInput!): PriceListUpdatePayload
privacyFeaturesDisable(featuresToDisable: [PrivacyFeaturesEnum!]!): PrivacyFeaturesDisablePayload
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
pubSubServerPixelUpdate(pubSubProject: String!, pubSubTopic: String!): PubSubServerPixelUpdatePayload
publicationCreate(input: PublicationCreateInput!): PublicationCreatePayload
publicationDelete(id: ID!): PublicationDeletePayload
publicationUpdate(id: ID!, input: PublicationUpdateInput!): PublicationUpdatePayload
publishablePublish(id: ID!, input: [PublicationInput!]!): PublishablePublishPayload
publishableUnpublish(id: ID!, input: [PublicationInput!]!): PublishableUnpublishPayload
quantityPricingByVariantUpdate(priceListId: ID!, input: QuantityPricingByVariantUpdateInput!): QuantityPricingByVariantUpdatePayload
quantityRulesAdd(priceListId: ID!, quantityRules: [QuantityRuleInput!]!): QuantityRulesAddPayload
quantityRulesDelete(priceListId: ID!, variantIds: [ID!]!): QuantityRulesDeletePayload
refundCreate(input: RefundInput!): RefundCreatePayload
removeFromReturn(returnId: ID!, returnLineItems: [ReturnLineItemRemoveFromReturnInput!], exchangeLineItems: [ExchangeLineItemRemoveFromReturnInput!]): RemoveFromReturnPayload
returnApproveRequest(input: ReturnApproveRequestInput!): ReturnApproveRequestPayload
returnCancel(id: ID!): ReturnCancelPayload
returnClose(id: ID!): ReturnClosePayload
returnCreate(returnInput: ReturnInput!): ReturnCreatePayload
returnDeclineRequest(input: ReturnDeclineRequestInput!): ReturnDeclineRequestPayload
returnProcess(input: ReturnProcessInput!): ReturnProcessPayload
returnReopen(id: ID!): ReturnReopenPayload
returnRequest(input: ReturnRequestInput!): ReturnRequestPayload
reverseDeliveryCreateWithShipping(reverseFulfillmentOrderId: ID!, reverseDeliveryLineItems: [ReverseDeliveryLineItemInput!]!, trackingInput: ReverseDeliveryTrackingInput, labelInput: ReverseDeliveryLabelInput, notifyCustomer: Boolean): ReverseDeliveryCreateWithShippingPayload
reverseDeliveryShippingUpdate(reverseDeliveryId: ID!, trackingInput: ReverseDeliveryTrackingInput, labelInput: ReverseDeliveryLabelInput, notifyCustomer: Boolean): ReverseDeliveryShippingUpdatePayload
reverseFulfillmentOrderDispose(dispositionInputs: [ReverseFulfillmentOrderDisposeInput!]!): ReverseFulfillmentOrderDisposePayload
savedSearchCreate(input: SavedSearchCreateInput!): SavedSearchCreatePayload
savedSearchDelete(input: SavedSearchDeleteInput!): SavedSearchDeletePayload
savedSearchUpdate(input: SavedSearchUpdateInput!): SavedSearchUpdatePayload
scriptTagCreate(input: ScriptTagInput!): ScriptTagCreatePayload
scriptTagDelete(id: ID!): ScriptTagDeletePayload
scriptTagUpdate(id: ID!, input: ScriptTagInput!): ScriptTagUpdatePayload
segmentCreate(name: String!, query: String!): SegmentCreatePayload
segmentDelete(id: ID!): SegmentDeletePayload
segmentUpdate(id: ID!, name: String, query: String): SegmentUpdatePayload
sellingPlanGroupAddProductVariants(id: ID!, productVariantIds: [ID!]!): SellingPlanGroupAddProductVariantsPayload
sellingPlanGroupAddProducts(id: ID!, productIds: [ID!]!): SellingPlanGroupAddProductsPayload
sellingPlanGroupCreate(input: SellingPlanGroupInput!, resources: SellingPlanGroupResourceInput): SellingPlanGroupCreatePayload
sellingPlanGroupDelete(id: ID!): SellingPlanGroupDeletePayload
sellingPlanGroupRemoveProductVariants(id: ID!, productVariantIds: [ID!]!): SellingPlanGroupRemoveProductVariantsPayload
sellingPlanGroupRemoveProducts(id: ID!, productIds: [ID!]!): SellingPlanGroupRemoveProductsPayload
sellingPlanGroupUpdate(id: ID!, input: SellingPlanGroupInput!): SellingPlanGroupUpdatePayload
serverPixelCreate: ServerPixelCreatePayload
serverPixelDelete: ServerPixelDeletePayload
shippingPackageDelete(id: ID!): ShippingPackageDeletePayload
shippingPackageMakeDefault(id: ID!): ShippingPackageMakeDefaultPayload
shippingPackageUpdate(id: ID!, shippingPackage: CustomShippingPackageInput!): ShippingPackageUpdatePayload
shopLocaleDisable(locale: String!): ShopLocaleDisablePayload
shopLocaleEnable(locale: String!, marketWebPresenceIds: [ID!]): ShopLocaleEnablePayload
shopLocaleUpdate(locale: String!, shopLocale: ShopLocaleInput!): ShopLocaleUpdatePayload
shopPolicyUpdate(shopPolicy: ShopPolicyInput!): ShopPolicyUpdatePayload
shopResourceFeedbackCreate(input: ResourceFeedbackCreateInput!): ShopResourceFeedbackCreatePayload
shopifyPaymentsPayoutAlternateCurrencyCreate(accountId: ID, currency: CurrencyCode!): ShopifyPaymentsPayoutAlternateCurrencyCreatePayload
stagedUploadsCreate(input: [StagedUploadInput!]!): StagedUploadsCreatePayload
standardMetafieldDefinitionEnable(ownerType: MetafieldOwnerType!, id: ID, namespace: String, key: String, pin: Boolean, capabilities: MetafieldCapabilityCreateInput, access: StandardMetafieldDefinitionAccessInput): StandardMetafieldDefinitionEnablePayload
standardMetaobjectDefinitionEnable(type: String!): StandardMetaobjectDefinitionEnablePayload
storeCreditAccountCredit(id: ID!, creditInput: StoreCreditAccountCreditInput!): StoreCreditAccountCreditPayload
storeCreditAccountDebit(id: ID!, debitInput: StoreCreditAccountDebitInput!): StoreCreditAccountDebitPayload
storefrontAccessTokenCreate(input: StorefrontAccessTokenInput!): StorefrontAccessTokenCreatePayload
storefrontAccessTokenDelete(input: StorefrontAccessTokenDeleteInput!): StorefrontAccessTokenDeletePayload
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
tagsAdd(id: ID!, tags: [String!]!): TagsAddPayload
tagsRemove(id: ID!, tags: [String!]!): TagsRemovePayload
taxAppConfigure(ready: Boolean!): TaxAppConfigurePayload
taxSummaryCreate(orderId: ID, startTime: DateTime, endTime: DateTime): TaxSummaryCreatePayload
themeCreate(source: URL!, name: String, role: ThemeRole): ThemeCreatePayload
themeDelete(id: ID!): ThemeDeletePayload
themeDuplicate(id: ID!, name: String): ThemeDuplicatePayload
themeFilesCopy(themeId: ID!, files: [ThemeFilesCopyFileInput!]!): ThemeFilesCopyPayload
themeFilesDelete(themeId: ID!, files: [String!]!): ThemeFilesDeletePayload
themeFilesUpsert(themeId: ID!, files: [OnlineStoreThemeFilesUpsertFileInput!]!): ThemeFilesUpsertPayload
themePublish(id: ID!): ThemePublishPayload
themeUpdate(id: ID!, input: OnlineStoreThemeInput!): ThemeUpdatePayload
transactionVoid(parentTransactionId: ID!): TransactionVoidPayload
translationsRegister(resourceId: ID!, translations: [TranslationInput!]!): TranslationsRegisterPayload
translationsRemove(resourceId: ID!, translationKeys: [String!]!, locales: [String!]!, marketIds: [ID!]): TranslationsRemovePayload
urlRedirectBulkDeleteAll: UrlRedirectBulkDeleteAllPayload
urlRedirectBulkDeleteByIds(ids: [ID!]!): UrlRedirectBulkDeleteByIdsPayload
urlRedirectBulkDeleteBySavedSearch(savedSearchId: ID!): UrlRedirectBulkDeleteBySavedSearchPayload
urlRedirectBulkDeleteBySearch(search: String!): UrlRedirectBulkDeleteBySearchPayload
urlRedirectCreate(urlRedirect: UrlRedirectInput!): UrlRedirectCreatePayload
urlRedirectDelete(id: ID!): UrlRedirectDeletePayload
urlRedirectImportCreate(url: URL!): UrlRedirectImportCreatePayload
urlRedirectImportSubmit(id: ID!): UrlRedirectImportSubmitPayload
urlRedirectUpdate(id: ID!, urlRedirect: UrlRedirectInput!): UrlRedirectUpdatePayload
validationCreate(validation: ValidationCreateInput!): ValidationCreatePayload
validationDelete(id: ID!): ValidationDeletePayload
validationUpdate(validation: ValidationUpdateInput!, id: ID!): ValidationUpdatePayload
webPixelCreate(webPixel: WebPixelInput!): WebPixelCreatePayload
webPixelDelete(id: ID!): WebPixelDeletePayload
webPixelUpdate(id: ID!, webPixel: WebPixelInput!): WebPixelUpdatePayload
webPresenceCreate(input: WebPresenceCreateInput!): WebPresenceCreatePayload
webPresenceDelete(id: ID!): WebPresenceDeletePayload
webPresenceUpdate(id: ID!, input: WebPresenceUpdateInput!): WebPresenceUpdatePayload
webhookSubscriptionCreate(topic: WebhookSubscriptionTopic!, webhookSubscription: WebhookSubscriptionInput!): WebhookSubscriptionCreatePayload
webhookSubscriptionDelete(id: ID!): WebhookSubscriptionDeletePayload
webhookSubscriptionUpdate(id: ID!, webhookSubscription: WebhookSubscriptionInput!): WebhookSubscriptionUpdatePayload
