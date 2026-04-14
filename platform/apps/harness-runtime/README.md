# @new-one-two/harness-runtime

The per-tenant runtime that executes LLM-generated handler code inside a
Cloud Run service. Shipped into every tenant Docker image via the deployer
(`packages/deployer/src/fs-builder.ts` → `dockerfile-template.ts`).

## Files shipped into the tenant image

| File | Purpose |
|---|---|
| `dist/server.cjs` | esbuild CJS bundle (all non-GCP deps inlined) |
| `runtime-package.json` | package.json for the three GCP-native deps |
| `runtime-package-lock.json` | lockfile for the three GCP-native deps |

The lockfile is **committed to git** and is what `npm ci` consumes during
the tenant Docker build. Without it, every deploy resolves fresh patch
versions of `@google-cloud/kms`, `@google-cloud/secret-manager`, and
`google-auth-library` — a single bad transitive release can break every
tenant's next deploy simultaneously.

## Regenerating `runtime-package-lock.json`

When you bump a dependency in `runtime-package.json`, regenerate the
lockfile in a scratch directory (never under the monorepo — npm will walk
up looking for a parent `package.json` and produce a polluted lockfile):

```bash
# From any directory outside the monorepo:
SCRATCH=$(mktemp -d)
cp platform/apps/harness-runtime/runtime-package.json "$SCRATCH/package.json"
( cd "$SCRATCH" && npm install --package-lock-only --ignore-scripts --no-audit --no-fund )
cp "$SCRATCH/package-lock.json" platform/apps/harness-runtime/runtime-package-lock.json
rm -rf "$SCRATCH"
```

Then commit both `runtime-package.json` and `runtime-package-lock.json`
in the same change.

## Notes

- Scripts are disabled during the `npm ci` in the tenant Docker build
  (`--ignore-scripts`) so a compromised transitive dep cannot run
  `preinstall`/`postinstall` during our build pipeline.
- Handler-declared dependencies (LLM-authored, allowlisted) are installed
  separately — see `packages/deployer/src/npm-allowlist.ts` for the rules.
