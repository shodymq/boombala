// The public site's TypeScript data (birthday packages, rooms) is imported by the platform's seed and tests. Those files use the
// site's extensionless imports and the `@/` alias, so this registers the site's loader before anything else runs.
import { register } from "node:module";

register(new URL("../../scripts/ts-loader.mjs", import.meta.url));
