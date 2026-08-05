// drizzle-kit config: `npx drizzle-kit generate` (run from this package)
// diffs src/schema.ts into SQL files under migrations/, which wrangler's
// `d1 migrations apply` then runs. drizzle-kit itself never ships.
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/schema.ts",
  out: "./migrations"
});
