import { sql } from "./connection.js";

export interface AppBundles {
  widgetJs: string | null;
  adminUiJs: string | null;
}

export async function updateAppBundles(
  appId: string,
  bundles: Partial<AppBundles>,
): Promise<void> {
  const { widgetJs, adminUiJs } = bundles;
  if (widgetJs === undefined && adminUiJs === undefined) return;

  if (widgetJs !== undefined && adminUiJs !== undefined) {
    await sql`
      UPDATE apps
      SET widget_js   = ${widgetJs},
          admin_ui_js = ${adminUiJs},
          updated_at  = NOW()
      WHERE id = ${appId}
    `;
  } else if (widgetJs !== undefined) {
    await sql`
      UPDATE apps SET widget_js = ${widgetJs}, updated_at = NOW() WHERE id = ${appId}
    `;
  } else {
    await sql`
      UPDATE apps SET admin_ui_js = ${adminUiJs!}, updated_at = NOW() WHERE id = ${appId}
    `;
  }
}

export async function getAppBundles(appId: string): Promise<AppBundles | null> {
  const rows = await sql<Array<{ widgetJs: string | null; adminUiJs: string | null }>>`
    SELECT widget_js AS "widgetJs", admin_ui_js AS "adminUiJs"
    FROM apps
    WHERE id = ${appId}
    LIMIT 1
  `;
  return rows[0] ?? null;
}
