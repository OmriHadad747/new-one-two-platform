# Runtime example: `compute_config`

Canonical working snippet. Adapt the names but preserve the shape — imports, error handling, contract checks.

```ts
import { config } from "../lib/config.js";

// Reads always supply a default — never assume a key is set on first run.
const rate: number = await config.get("points_per_dollar", 1);
const enabled: boolean = await config.get("notifications_enabled", false);

// Writes (typical admin "save settings" route):
await config.set("points_per_dollar", req.body.rate);

// Read multiple keys for a settings-page pre-fill:
const subset = await config.getMany(["points_per_dollar", "alert_thresholds"]);

// Read every key (admin "list all settings" page):
const all = await config.getAll();
```
