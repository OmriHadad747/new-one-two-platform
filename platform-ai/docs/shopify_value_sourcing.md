# Shopify value sourcing — why `dataNeeds` carry a `source`

*Maintainer doc. This is rationale, not agent context — it is intentionally kept
out of `context/` so no agent prompt ingests it.*

## The problem

The HLD architect lists, per capability, the values it needs (`dataNeeds`). That
list used to be free text — bare names like `"variant live price"`. Nothing
recorded **where** each value comes from. So the architect could promise a
Shopify-owned value (a live price, a variant gid) on a `compute` capability with
`integration: null` and **no** `shopifyStep` to fetch it. The plan validated fine.

The coding agent was then handed a value with no source. It did one of two bad
things: **fabricated** it (a fake gid that breaks add-to-cart) or **silently
dropped** the feature (the requested "live bundle total" that never rendered).
The architect was even *told* about this in prose, but the rule was advisory and
the field was untyped, so nothing connected or enforced it.

## The fix

`dataNeeds` is now a list of `{ name, source }` objects. `source` is one of:

| source     | meaning                                                        |
|------------|----------------------------------------------------------------|
| `shopify`  | fetched **live** from Shopify by this capability                |
| `trigger`  | delivered in the event/webhook payload                          |
| `request`  | supplied in the inbound HTTP request                            |
| `upstream` | produced by a prior capability earlier in the same in-app flow  |
| `config`   | a merchant-tunable setting                                      |
| `constant` | a fixed / in-app-derived value                                  |

A static Pydantic validator enforces **only** `shopify`: a `source: "shopify"`
need forces the capability to be `shopify-admin`/`shopify-storefront` **and** to
carry a `shopifyStep` whose `produces` names that value. A `compute`/`null`
capability therefore *cannot* hold a Shopify-owned need — the plan is rejected
before the coding agent ever sees it. Deterministic, no model call.

The other five sources are honest **declarations**, not structurally checked (the
plan has no trigger/contract/upstream *graph* to check them against). They mirror
the reachability sources the `hld_v` reviewer's Rule B already recognizes, and the
reviewer still judges them semantically.

## Division of responsibility

| Who | Owns |
|-----|------|
| **Architect (HLD)** | Declares *which* needs are Shopify-owned (`source: shopify`) and names the resolving op in `shopifySteps`. Altitude-only — does not build fetch chains. |
| **Schema (static validator)** | Guarantees a `source: shopify` need is realizable: shopify-typed capability + a matching `shopifyStep.produces`. Pass/fail. |
| **hld_v (semantic reviewer)** | Judges whether a declared source is the *right* one — including catching a Shopify value **mislabeled** as `trigger`/`config` to dodge the fetch. No longer polices source *existence* (now structural). |
| **Coding agent** | Given the named op, fetches the value correctly using `context/runtime_examples/shopify_resolutions.md`. |

## Where the resolutions live

`shopify_resolutions.md` stays on the **coding** side. It answers *how* to fetch —
the call chain and the traps (a live price is never stored, so fetch the product
then read the variant price; a cart needs a **variant** gid, not a product gid;
some values need a chained create→use-id call). The schema and the architect
answer *what* is needed and *whether a source exists at all*. Keeping the two
apart is deliberate: the architect declares intent at altitude; the coding agent
owns the concrete GraphQL.
