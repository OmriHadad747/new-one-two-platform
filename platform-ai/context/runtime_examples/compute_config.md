# Helper: `config`

Use the `config` helper for every app-wide setting (rate, threshold, toggle,
TTL, choice). Backed by the platform-owned `app_config` table — do NOT declare a
config/settings table and do NOT read settings with a raw `SELECT`.

```ts
import { config } from "../lib/config.js";

// Reads always supply a default — never assume a key is set on first run.
const rate: number = await config.get("points_per_dollar", 1);
const enabled: boolean = await config.get("notifications_enabled", false);

await config.set("points_per_dollar", req.body.rate); // write (upsert)
const subset = await config.getMany(["points_per_dollar", "alert_thresholds"]);
const all = await config.getAll(); // admin "list all settings" page
```

Rules:
- Always pass a default to `get` — never assume a key is set on first run.
- Keys: lowercase snake_case, `^[a-z][a-z0-9_]{0,62}$`; group by prefix
  (`notification_*`, `discount_*`) so an admin page can list them coherently.
- An admin "save settings" route collapses to: validate → `config.set` → 200.
- Writes are last-writer-wins; for a counter-style value use a real DB column.
