// ─── npm package allowlist for LLM-authored handler bundles ───────────────────
// Canonical list of npm packages a generated handler is allowed to declare in
// its bundle's `_metadata.json → npmPackages` field.
//
// This list MUST stay in sync with the generator's `ALLOWED_NPM_PACKAGES` set
// at `generator/subagents/static_validation.py`. The deployer enforces the
// list INDEPENDENTLY so that a compromised, buggy, or prompt-injected
// generator cannot install arbitrary packages into the tenant Cloud Run
// image — defense in depth.
//
// To add a package:
//   1. Add it to ALLOWED_NPM_PACKAGES below.
//   2. Add it to the generator's ALLOWED_NPM_PACKAGES.
//   3. Add a pinned version + documented use case to
//      generator/templates/harness_contract.py.
//
// Keep the list tight. Each entry is runtime code we ship to tenants; every
// new dependency expands the audit surface for every merchant.

export const ALLOWED_NPM_PACKAGES: ReadonlySet<string> = new Set([
  "qrcode",
  "jsbarcode",
  "@xmldom/xmldom",
  "sharp",
  "pdfkit",
  "exceljs",
  "csv-parse",
  "csv-stringify",
  "fast-xml-parser",
  "handlebars",
  "marked",
  "dayjs",
  "jszip",
  "uuid",
  "slugify",
]);

/**
 * Accepts `name@x.y.z` or `@scope/name@x.y.z` with an optional pre-release
 * suffix. Intentionally strict:
 *   - Name: lowercase alphanumerics + `-_.`, optionally preceded by `@scope/`.
 *   - Version: exact semver (major.minor.patch) with optional pre-release.
 * This rule rejects version ranges (`^`, `~`, `*`, `>=`), dist-tags
 * (`latest`, `next`), and anything that could be mistaken for an npm CLI
 * flag (e.g. `--registry=http://evil`).
 */
const PINNED_SEMVER_RE =
  /^(@[a-z0-9][a-z0-9-_.]*\/)?[a-z0-9][a-z0-9-_.]*@\d+\.\d+\.\d+(-[0-9a-z.-]+)?$/i;

/**
 * Sanity cap. A bundle with more than this many declared packages is almost
 * certainly a malformed or prompt-injected generation — reject it rather
 * than explode the build context.
 */
export const MAX_PACKAGES = 20;

export interface NpmValidationResult {
  ok: boolean;
  errors: string[];
}

/**
 * Validates a list of `npmPackages` entries from a generated bundle.
 * Returns an aggregated result — all entries are checked so the deploy
 * failure message can list every problem at once.
 */
export function validateNpmPackages(pkgs: readonly unknown[]): NpmValidationResult {
  const errors: string[] = [];

  if (pkgs.length > MAX_PACKAGES) {
    errors.push(
      `npmPackages has ${pkgs.length} entries; limit is ${MAX_PACKAGES}. ` +
        `A larger list likely indicates prompt injection or a malformed bundle.`
    );
  }

  for (const raw of pkgs) {
    if (typeof raw !== "string") {
      errors.push(
        `npmPackages contains a non-string entry (type=${typeof raw})`
      );
      continue;
    }

    const entry = raw.trim();
    if (!entry) {
      errors.push("npmPackages contains an empty string");
      continue;
    }

    // Reject anything that could be mistaken for an npm CLI flag. The
    // Dockerfile template no longer splats entries into a shell command
    // (see dockerfile-template.ts), but a leading `-` in a package.json
    // dependency key still produces a confusing npm error — fail fast here.
    if (entry.startsWith("-")) {
      errors.push(
        `npmPackages entry '${entry}' starts with '-' (looks like a CLI flag); rejected.`
      );
      continue;
    }

    if (!PINNED_SEMVER_RE.test(entry)) {
      errors.push(
        `npmPackages entry '${entry}' is not in the required form ` +
          `'<name>@<major.minor.patch>' (no ranges, no tags).`
      );
      continue;
    }

    const base = packageBaseName(entry);
    if (!ALLOWED_NPM_PACKAGES.has(base)) {
      errors.push(
        `npmPackages entry '${entry}' declares package '${base}' ` +
          `which is not in the allowlist. ` +
          `Allowed: ${[...ALLOWED_NPM_PACKAGES].sort().join(", ")}.`
      );
      continue;
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Splits `<name>@<version>` into just `<name>`, handling scoped packages.
 *   "uuid@9.0.1"            -> "uuid"
 *   "@xmldom/xmldom@0.8.10" -> "@xmldom/xmldom"
 */
export function packageBaseName(entry: string): string {
  if (entry.startsWith("@")) {
    // @scope/name@version — the version `@` is the second `@` in the string.
    const at = entry.indexOf("@", 1);
    return at === -1 ? entry : entry.slice(0, at);
  }
  const at = entry.indexOf("@");
  return at === -1 ? entry : entry.slice(0, at);
}

/**
 * Extracts the pinned version from an entry that has already passed
 * `validateNpmPackages`. Throws on a malformed entry so callers can fail
 * loud if the invariant is ever violated.
 */
export function packageVersion(entry: string): string {
  const base = packageBaseName(entry);
  if (entry.length === base.length) {
    throw new Error(`packageVersion: no version in '${entry}'`);
  }
  return entry.slice(base.length + 1);
}

/**
 * Builds a `dependencies` record suitable for dropping into a package.json.
 * Each version is copied verbatim from the validated input so npm installs
 * exactly that version.
 */
export function toDependenciesMap(
  pkgs: readonly string[]
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of pkgs) {
    out[packageBaseName(entry)] = packageVersion(entry);
  }
  return out;
}
