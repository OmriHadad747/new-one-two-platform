import { logger } from "@new-one-two/logger";

/**
 * Shopify Theme Injection
 *
 * Flow:
 *   1. getThemeTemplates   — lists JSON templates in the active theme + sections in each
 *   2. duplicateTheme      — copies the active theme to a new draft theme
 *   3. injectAppBlock      — adds the widget-runtime app block to a specific section in a template
 *
 * The extension UID is the theme app extension handle registered in shopify.app.toml.
 * Shopify resolves the block type from the UID at render time — the merchant doesn't
 * need to know about it.
 *
 * All calls use the Admin REST API 2026-01.
 */

const API_VERSION = "2026-01";

// Block handle = filename of blocks/app-block.liquid (not the extension handle)
const WIDGET_BLOCK_HANDLE  = "app-block";
const WIDGET_EXTENSION_UID = process.env["SHOPIFY_WIDGET_EXTENSION_UID"] ?? "";

// Shopify app client ID — needed to build the block type path
const SHOPIFY_CLIENT_ID = process.env["SHOPIFY_CLIENT_ID"] ?? "";

/**
 * The exact block type URI Shopify stores in template JSON when our app block is added.
 * Format: shopify://apps/{api_key}/blocks/{handle}/{extension_uid}
 * Shopify validates this against installed extensions and strips unrecognised types silently.
 */
const WIDGET_BLOCK_TYPE = `shopify://apps/${SHOPIFY_CLIENT_ID}/blocks/${WIDGET_BLOCK_HANDLE}/${WIDGET_EXTENSION_UID}`;

function widgetBlockType(): string {
  return WIDGET_BLOCK_TYPE;
}

/** Returns true if a block type URI belongs to our widget extension. */
function isOurBlock(type: string): boolean {
  return type === WIDGET_BLOCK_TYPE;
}

// Template files that support widget injection.
// Covers all standard Shopify OS 2.0 templates where an app block makes sense.
const INJECTABLE_TEMPLATES = [
  "templates/product.json",
  "templates/collection.json",
  "templates/index.json",
  "templates/cart.json",
  "templates/page.json",
  "templates/blog.json",
  "templates/article.json",
  "templates/search.json",
];

type ShopifyApiHeaders = {
  "Content-Type": string;
  "X-Shopify-Access-Token": string;
};

function headers(token: string): ShopifyApiHeaders {
  return {
    "Content-Type": "application/json",
    "X-Shopify-Access-Token": token,
  };
}

async function shopifyGet<T>(shop: string, token: string, path: string): Promise<T> {
  const res = await fetch(`https://${shop}/admin/api/${API_VERSION}${path}`, {
    headers: headers(token),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Shopify GET ${path} failed [${res.status}]: ${body}`);
  }
  return res.json() as Promise<T>;
}


async function shopifyPut<T>(shop: string, token: string, path: string, body: unknown): Promise<T> {
  const res = await fetch(`https://${shop}/admin/api/${API_VERSION}${path}`, {
    method: "PUT",
    headers: headers(token),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shopify PUT ${path} failed [${res.status}]: ${text}`);
  }
  return res.json() as Promise<T>;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TemplateSection {
  sectionId: string;
  sectionType: string;
  /** Human-readable name from the section's Liquid schema (e.g. "Product information") */
  sectionName?: string;
  /** Ordered list of block IDs in this section */
  blockOrder: string[];
  /** Display name for each block in blockOrder, keyed by block ID */
  blockNames: Record<string, string>;
  /** Whether this section already has an app block from us */
  hasOurBlock: boolean;
}

export interface ThemeTemplate {
  /** e.g. "product", "collection", "index" */
  name: string;
  /** e.g. "templates/product.json" */
  key: string;
  /** Sections within this template that accept blocks */
  sections: TemplateSection[];
}

export interface ActiveTheme {
  id: number;
  name: string;
}

// ─── 1. Get active theme ──────────────────────────────────────────────────────

export async function getActiveTheme(shop: string, token: string): Promise<ActiveTheme> {
  const data = await shopifyGet<{ themes: Array<{ id: number; name: string; role: string }> }>(
    shop, token, "/themes.json"
  );
  const main = data.themes.find((t) => t.role === "main");
  if (!main) throw new Error("No active (main) theme found");
  return { id: main.id, name: main.name };
}

// ─── 2. Get injectable templates from a theme ─────────────────────────────────

const TEMPLATE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const templateCache = new Map<string, { data: ThemeTemplate[]; expiresAt: number }>();

function getCached(shop: string, themeId: number): ThemeTemplate[] | null {
  const entry = templateCache.get(`${shop}:${themeId}`);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { templateCache.delete(`${shop}:${themeId}`); return null; }
  return entry.data;
}

function setCached(shop: string, themeId: number, data: ThemeTemplate[]): void {
  templateCache.set(`${shop}:${themeId}`, { data, expiresAt: Date.now() + TEMPLATE_CACHE_TTL_MS });
}

type SectionRecord = Record<string, {
  type: string;
  blocks?: Record<string, { type: string; settings?: Record<string, unknown> }>;
  block_order?: string[];
  settings?: Record<string, unknown>;
}>;

/** Returns true for auto-generated hex/UUID section IDs like `a1b2c3d4` or `550e8400-e29b-41d4-a716-446655440000`. */
function isHexId(id: string): boolean {
  return id.length >= 8 && /^[0-9a-f-]+$/i.test(id) && /\d/.test(id);
}

/** Intermediate type — blockNames resolved later once Liquid schemas are loaded. */
type ParsedSection = {
  sectionId: string;
  sectionType: string;
  blockOrder: string[];
  /** blockId → raw Shopify block type string (resolved to display name later) */
  rawBlockTypes: Record<string, string>;
  hasOurBlock: boolean;
};

function parseSections(sections: SectionRecord): ParsedSection[] {
  return Object.entries(sections)
    .filter(([sectionId]) => !isHexId(sectionId))
    .map(([sectionId, section]) => {
      const blockOrder = section.block_order ?? [];
      const blocks = section.blocks ?? {};
      const hasOurBlock = Object.values(blocks).some((b) => isOurBlock(b.type));
      const rawBlockTypes: Record<string, string> = {};
      for (const [id, b] of Object.entries(blocks)) rawBlockTypes[id] = b.type;
      return { sectionId, sectionType: section.type, blockOrder, rawBlockTypes, hasOurBlock };
    });
}

/**
 * Converts a raw Shopify block type to a human-readable display name.
 * Uses schema-derived names when available, falls back to humanizing the type string.
 */
function resolveBlockName(
  blockType: string,
  sectionType: string,
  blockSchemaMap: Map<string, Map<string, string>>
): string {
  const fromSchema = blockSchemaMap.get(sectionType)?.get(blockType);
  // Only use schema value if it was fully resolved (not a raw t: key)
  if (fromSchema && !fromSchema.startsWith("t:")) return fromSchema;
  if (blockType.startsWith("shopify://apps/")) {
    const handle = /\/blocks\/([^/]+)/.exec(blockType)?.[1];
    return handle
      ? handle.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
      : "App block";
  }
  return blockType.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function resolveSection(
  s: ParsedSection,
  sectionName: string,
  blockSchemaMap: Map<string, Map<string, string>>
): TemplateSection {
  const blockNames: Record<string, string> = {};
  for (const id of s.blockOrder) {
    const type = s.rawBlockTypes[id];
    if (type) blockNames[id] = resolveBlockName(type, s.sectionType, blockSchemaMap);
  }
  return { sectionId: s.sectionId, sectionType: s.sectionType, sectionName, blockOrder: s.blockOrder, blockNames, hasOurBlock: s.hasOurBlock };
}

export async function getThemeTemplates(
  shop: string,
  token: string,
  themeId: number
): Promise<ThemeTemplate[]> {
  const cached = getCached(shop, themeId);
  if (cached) return cached;

  // Fetch asset list to find which JSON templates and section group files exist
  const assetsData = await shopifyGet<{ assets: Array<{ key: string }> }>(
    shop, token, `/themes/${themeId}/assets.json`
  );

  const allKeys = assetsData.assets.map((a) => a.key);

  const templateKeys = allKeys.filter((k) => INJECTABLE_TEMPLATES.includes(k));

  // Section group files in Shopify 2.0 themes are stored as sections/*.json
  // (distinct from sections/*.liquid which are regular section files).
  // These contain globally-rendered sections like header, footer, announcement bar.
  const sectionGroupKeys = allKeys
    .filter((k) => k.startsWith("sections/") && k.endsWith(".json"))
    .slice(0, 10); // cap to avoid runaway API calls on unusual themes

  // Fetch global sections from section group files (header, footer, etc.)
  const globalSections: ParsedSection[] = [];
  for (const key of sectionGroupKeys) {
    try {
      const groupAsset = await shopifyGet<{ asset: { value: string } }>(
        shop, token, `/themes/${themeId}/assets.json?asset[key]=${encodeURIComponent(key)}`
      );
      const groupJson = JSON.parse(groupAsset.asset.value) as { sections?: SectionRecord };
      globalSections.push(...parseSections(groupJson.sections ?? {}));
    } catch {
      // Skip unparseable section group files
    }
  }

  // Collect all unique section types across templates and global sections
  // to fetch their schema names in batch (one API call per unique type).
  const allSectionTypes = new Set<string>();
  const rawTemplates: Array<{ key: string; sections: ParsedSection[] }> = [];

  for (const key of templateKeys) {
    try {
      const assetData = await shopifyGet<{ asset: { value: string } }>(
        shop, token, `/themes/${themeId}/assets.json?asset[key]=${encodeURIComponent(key)}`
      );
      const templateJson = JSON.parse(assetData.asset.value) as {
        sections?: SectionRecord;
        order?: string[];
      };
      const templateSections = parseSections(templateJson.sections ?? {});
      templateSections.forEach((s) => allSectionTypes.add(s.sectionType));
      rawTemplates.push({ key, sections: templateSections });
    } catch {
      // Skip templates that can't be parsed
    }
  }
  globalSections.forEach((s) => allSectionTypes.add(s.sectionType));

  // Fetch the theme's default locale file once — needed to resolve t: translation keys
  // (Shopify Dawn and most modern themes use "t:sections.foo.name" in schema `name` fields)
  let locale: Record<string, unknown> = {};
  try {
    const localeAsset = await shopifyGet<{ asset: { value: string } }>(
      shop, token, `/themes/${themeId}/assets.json?asset[key]=locales%2Fen.default.json`
    );
    locale = JSON.parse(localeAsset.asset.value) as Record<string, unknown>;
  } catch {
    // Locale file not found or not parseable — translation keys will fall back to the raw type string
  }

  function resolveLocaleKey(key: string): string {
    if (!key.startsWith("t:")) return key;
    const parts = key.slice(2).split(".");
    let node: unknown = locale;
    for (const part of parts) {
      if (typeof node !== "object" || node === null) return key;
      node = (node as Record<string, unknown>)[part];
    }
    return typeof node === "string" ? node : key;
  }

  // Fetch section names AND block name maps from Liquid schemas
  const sectionNameMap = new Map<string, string>();
  // sectionType → (blockType → display name)
  const blockSchemaMap = new Map<string, Map<string, string>>();
  for (const type of allSectionTypes) {
    if (!type || type.startsWith("@")) continue;
    try {
      const liquidAsset = await shopifyGet<{ asset: { value: string } }>(
        shop, token, `/themes/${themeId}/assets.json?asset[key]=${encodeURIComponent(`sections/${type}.liquid`)}`
      );
      const schemaMatch = /\{%-?\s*schema\s*-?%\}([\s\S]*?)\{%-?\s*endschema\s*-?%\}/i.exec(liquidAsset.asset.value);
      if (schemaMatch?.[1]) {
        const schema = JSON.parse(schemaMatch[1]) as {
          name?: string;
          blocks?: Array<{ type?: string; name?: string }>;
        };
        if (schema.name) sectionNameMap.set(type, resolveLocaleKey(schema.name));
        if (schema.blocks?.length) {
          const blockNames = new Map<string, string>();
          for (const b of schema.blocks) {
            if (b.type && b.name) {
              const resolved = resolveLocaleKey(b.name);
              // Only store if the locale key was actually resolved to a plain string
              if (!resolved.startsWith("t:")) blockNames.set(b.type, resolved);
            }
          }
          if (blockNames.size > 0) blockSchemaMap.set(type, blockNames);
        }
      }
    } catch {
      // Section liquid not found or schema not parseable — use type as-is
    }
  }

  // Resolve ParsedSection → TemplateSection with names applied
  const globalWithNames = globalSections.map((s) =>
    resolveSection(s, sectionNameMap.get(s.sectionType) ?? s.sectionType, blockSchemaMap)
  );

  const templates: ThemeTemplate[] = rawTemplates.map(({ key, sections }) => {
    const withNames = sections.map((s) =>
      resolveSection(s, sectionNameMap.get(s.sectionType) ?? s.sectionType, blockSchemaMap)
    );
    // Merge global sections, deduplicating by sectionId (template-local wins)
    const localIds = new Set(withNames.map((s) => s.sectionId));
    const merged = [
      ...withNames,
      ...globalWithNames.filter((s) => !localIds.has(s.sectionId)),
    ];
    const templateName = key.replace("templates/", "").replace(".json", "");
    return { name: templateName, key, sections: merged };
  });

  setCached(shop, themeId, templates);
  return templates;
}

// ─── 3. Duplicate the active theme (via GraphQL themeDuplicate mutation) ──────
//
// The REST POST /themes.json with a `src` URL cannot use internal Shopify admin
// clone URLs — they require browser session auth and return 403. The correct
// approach is the GraphQL Admin API `themeDuplicate` mutation (2023-10+).

async function shopifyGraphQL<T>(
  shop: string,
  token: string,
  query: string,
  variables?: Record<string, unknown>
): Promise<T> {
  const res = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shopify GraphQL failed [${res.status}]: ${text}`);
  }
  const json = await res.json() as { data?: T; errors?: Array<{ message: string }> };
  if (json.errors?.length) {
    throw new Error(`Shopify GraphQL: ${json.errors.map((e) => e.message).join(", ")}`);
  }
  if (!json.data) throw new Error("Shopify GraphQL returned no data");
  return json.data;
}

export async function duplicateTheme(
  shop: string,
  token: string,
  sourceThemeId: number,
  newName: string
): Promise<{ id: number; name: string }> {
  const gid = `gid://shopify/OnlineStoreTheme/${sourceThemeId}`;

  const result = await shopifyGraphQL<{
    themeDuplicate: {
      newTheme: { id: string; name: string } | null;
      userErrors: Array<{ field: string[]; message: string }>;
    };
  }>(
    shop, token,
    `mutation themeDuplicate($id: ID!) {
      themeDuplicate(id: $id) {
        newTheme { id name }
        userErrors { field message }
      }
    }`,
    { id: gid }
  );

  const { newTheme, userErrors } = result.themeDuplicate;
  if (userErrors.length > 0) {
    throw new Error(`Theme duplication failed: ${userErrors.map((e) => e.message).join(", ")}`);
  }
  if (!newTheme) throw new Error("themeDuplicate returned no theme");

  const numericId = parseInt(newTheme.id.split("/").pop() ?? "0", 10);
  if (!numericId) throw new Error("Failed to parse duplicated theme ID");

  // Poll until Shopify finishes processing the copy (async on their end)
  let attempts = 0;
  while (attempts < 30) {
    await new Promise((r) => setTimeout(r, 2000));
    const check = await shopifyGet<{ theme: { processing: boolean } }>(
      shop, token, `/themes/${numericId}.json`
    );
    if (!check.theme.processing) break;
    attempts++;
  }
  // Brief extra wait — assets can still be syncing right after processing flag clears
  await new Promise((r) => setTimeout(r, 3000));

  // Rename the duplicate to the desired name
  await shopifyPut(shop, token, `/themes/${numericId}.json`, {
    theme: { id: numericId, name: newName },
  });

  return { id: numericId, name: newName };
}

// ─── 4. Inject app block into a section ──────────────────────────────────────

export interface InjectionTarget {
  templateKey: string;   // e.g. "templates/product.json"
  sectionId: string;     // e.g. "main-product"
  /** Index in block_order where the widget is inserted. 0 = before first block, length = after last. */
  position: number;
}

type TemplateJson = {
  sections: Record<string, {
    type: string;
    blocks?: Record<string, { type: string; disabled?: boolean; settings?: Record<string, unknown> }>;
    block_order?: string[];
  }>;
  order?: string[];
};

/** Strip /* … *\/ block comments that Shopify Dawn prepends to template JSON files. */
function stripJsonComments(raw: string): string {
  return raw.replace(/\/\*[\s\S]*?\*\//g, "").trim();
}

async function fetchTemplateJson(
  shop: string, token: string, themeId: number, templateKey: string
): Promise<TemplateJson> {
  const assetData = await shopifyGet<{ asset: { value: string } }>(
    shop, token,
    `/themes/${themeId}/assets.json?asset[key]=${encodeURIComponent(templateKey)}`
  );
  return JSON.parse(stripJsonComments(assetData.asset.value)) as TemplateJson;
}

export async function injectAppBlock(
  shop: string,
  token: string,
  themeId: number,
  appId: string,
  target: InjectionTarget
): Promise<void> {
  const blockId = `platform-widget-${appId.slice(0, 8)}`;
  const blockType = widgetBlockType();

  // Wait for the template to stabilize before writing.
  // Shopify's async theme-copy sync can overwrite any asset we write while it's
  // still running — even after `processing: false` clears. We poll with two
  // consecutive reads 2 s apart; if both are identical the sync has settled.
  let stableJson: TemplateJson | null = null;
  for (let i = 0; i < 12; i++) {
    const a = await fetchTemplateJson(shop, token, themeId, target.templateKey);
    await new Promise((r) => setTimeout(r, 2000));
    const b = await fetchTemplateJson(shop, token, themeId, target.templateKey);
    if (JSON.stringify(a) === JSON.stringify(b)) {
      stableJson = b;
      break;
    }
    // Still changing — wait 2 s more before the next pair
    await new Promise((r) => setTimeout(r, 2000));
  }

  if (!stableJson) {
    throw new Error(
      `Theme template "${target.templateKey}" never stabilized after duplication. ` +
      `Try again in a moment once the theme has finished processing.`
    );
  }

  const section = stableJson.sections[target.sectionId];
  if (!section) {
    throw new Error(`Section "${target.sectionId}" not found in ${target.templateKey}`);
  }

  // Insert the block at the requested position
  if (!section.blocks) section.blocks = {};
  section.blocks[blockId] = { type: blockType, disabled: false, settings: {} };

  if (!section.block_order) section.block_order = [];
  section.block_order = section.block_order.filter((id) => id !== blockId);
  const idx = Math.max(0, Math.min(target.position, section.block_order.length));
  section.block_order.splice(idx, 0, blockId);

  logger.info({ blockId, blockType, template: target.templateKey, section: target.sectionId }, "Writing app block to theme template");

  await shopifyPut<{ asset: { key: string } }>(shop, token, `/themes/${themeId}/assets.json`, {
    asset: {
      key: target.templateKey,
      value: JSON.stringify(stableJson, null, 2),
    },
  });

  // Shopify doesn't always return `value` in the PUT response (large assets get public_url).
  // Fetch once immediately to check if the block was accepted or stripped.
  await new Promise((r) => setTimeout(r, 1500));
  const immediateRead = await fetchTemplateJson(shop, token, themeId, target.templateKey);
  const immediateSection = immediateRead.sections[target.sectionId];
  if (!immediateSection?.block_order?.includes(blockId) || !immediateSection.blocks?.[blockId]) {
    const presentTypes = Object.values(immediateSection?.blocks ?? {}).map((b: unknown) => (b as { type?: string }).type ?? "?");
    logger.error({ blockId, blockType, presentTypes }, "Block was stripped — extension not recognised by Shopify");
    throw new Error(
      `Shopify rejected the app block (stripped on write). ` +
      `Block type: "${blockType}". ` +
      `Make sure the extension is deployed: run \`shopify app deploy\` from the shopify-app directory.`
    );
  }

  // Block was accepted — do one more check to guard against async theme-sync race.
  const verifyDelays = [3000, 5000, 8000];
  for (const delay of verifyDelays) {
    await new Promise((r) => setTimeout(r, delay));
    const verify = await fetchTemplateJson(shop, token, themeId, target.templateKey);
    const vs = verify.sections[target.sectionId];
    if (vs?.block_order?.includes(blockId) && vs.blocks?.[blockId]) return;
    logger.warn({ blockId, delay }, "Block accepted by Shopify but not yet visible in read-back — may still be syncing");
  }
  throw new Error(
    `Block was accepted by Shopify but did not appear in subsequent reads. ` +
    `The theme may still be syncing — try again in a moment.`
  );
}

// ─── 5. Get theme preview URL ─────────────────────────────────────────────────

export function themePreviewUrl(shop: string, themeId: number): string {
  return `https://${shop}/?preview_theme_id=${themeId}`;
}

export function themeEditorUrl(shop: string, themeId: number): string {
  return `https://${shop}/admin/themes/${themeId}/editor`;
}
