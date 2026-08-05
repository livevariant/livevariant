// Generation-only config for `@better-auth/cli generate`: same plugins as
// src/auth.ts so the emitted Drizzle schema matches the runtime exactly.
// Never imported at runtime.
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { magicLink, organization } from "better-auth/plugins";

export const auth = betterAuth({
  database: drizzleAdapter({} as never, { provider: "sqlite" }),
  emailAndPassword: { enabled: false },
  secret: "cli-generation-only",
  plugins: [magicLink({ sendMagicLink: async () => undefined }), organization()]
});
