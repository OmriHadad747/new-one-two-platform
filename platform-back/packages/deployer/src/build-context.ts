import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { logger } from "@platform-back/logger";

// Assembles the directory that gets handed to `docker build`.
//
// Source 1: handler-template — the hand-written reference handler that
//   ships with platform-back. Copied verbatim (Dockerfile, package.json,
//   server.ts, middleware/, lib/, the three trust-domain route files,
//   migrations/0001_template_baseline.sql, etc.).
//
// Source 2: generator-emitted files — slotted in on top of the template.
//   Most commonly: replacement bodies for routes/admin.ts / webhook.ts /
//   widget.ts and additional migrations under migrations/. Anything the
//   template ships gets overwritten by the generated equivalent if a
//   matching path is provided.
//
// The build context is a fresh temp directory per call — we never reuse
// or mutate handler-template/ in place.

export interface GeneratedFile {
  /** Path RELATIVE to the build root. e.g. "src/routes/admin.ts". */
  path: string;
  contents: string;
}

export interface AssembleBuildContextInput {
  /** Absolute path to handler-template (defaults to platform-back/templates/handler). */
  templatePath?: string;
  generatedFiles: GeneratedFile[];
  /** Tenant + app context — written into a small build-info.json for traceability. */
  tenantId: string;
  appId: string;
  appVersion: string;
}

export interface AssembleBuildContextResult {
  /** Absolute path to the assembled build directory. Caller is responsible for cleanup. */
  buildDir: string;
}

const DEFAULT_TEMPLATE_PATH = resolve(
  // packages/deployer/dist/build-context.js → ../../templates/handler
  new URL("../../../templates/handler", import.meta.url).pathname,
);

const COPY_FILTER_EXCLUDE = /\b(node_modules|dist|\.env|\.env\.local|\.git)\b/;

export async function assembleBuildContext(
  input: AssembleBuildContextInput,
): Promise<AssembleBuildContextResult> {
  const templatePath = input.templatePath ?? DEFAULT_TEMPLATE_PATH;
  const buildDir = await mkdtemp(join(tmpdir(), `handler-build-${input.appId}-`));

  // 1. Copy handler-template, skipping node_modules / dist / dotenv files.
  await cp(templatePath, buildDir, {
    recursive: true,
    filter: (src) => !COPY_FILTER_EXCLUDE.test(src),
  });

  // 2. Slot in generated files. Reject path-traversal explicitly — the
  //    generator emits arbitrary filenames and we MUST keep writes inside
  //    the build directory.
  for (const file of input.generatedFiles) {
    if (file.path.startsWith("/") || file.path.includes("..")) {
      throw new Error(
        `assembleBuildContext: refusing path "${file.path}" — must be a relative path with no ".."`,
      );
    }
    const dest = join(buildDir, file.path);
    if (!dest.startsWith(buildDir + "/") && dest !== buildDir) {
      throw new Error(
        `assembleBuildContext: path "${file.path}" resolved outside the build directory`,
      );
    }
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, file.contents, "utf-8");
  }

  // 3. Drop a build-info.json so the deployed container can prove its
  //    provenance from inside (useful when triaging "which version is
  //    actually serving"). Read from the handler at startup if needed;
  //    for now it's just a debugging hook.
  await writeFile(
    join(buildDir, "build-info.json"),
    JSON.stringify(
      {
        tenantId: input.tenantId,
        appId: input.appId,
        appVersion: input.appVersion,
        generatedFileCount: input.generatedFiles.length,
        assembledAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    "utf-8",
  );

  // 4. Sanity: confirm the Dockerfile actually arrived (the template
  //    should always provide one, but if someone runs against a misnamed
  //    template path it's better to fail loudly here than at docker build).
  try {
    await readFile(join(buildDir, "Dockerfile"), "utf-8");
  } catch {
    throw new Error(
      `assembleBuildContext: no Dockerfile at ${buildDir}/Dockerfile — ` +
        `template path "${templatePath}" doesn't look like a handler template`,
    );
  }

  logger.info(
    {
      buildDir,
      templatePath,
      appId: input.appId,
      generatedFileCount: input.generatedFiles.length,
    },
    "Build context assembled",
  );
  return { buildDir };
}
