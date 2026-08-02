import baseConfig from "../../eslint.config.mjs";

export default [
  ...baseConfig,
  {
    files: ["**/*.json"],
    rules: {
      "@nx/dependency-checks": [
        "error",
        {
          ignoredFiles: [
            "{projectRoot}/eslint.config.{js,cjs,mjs,ts,cts,mts}",
            "{projectRoot}/vite.config.mts",
            "{projectRoot}/vitest.config.mts"
          ],
          ignoredDependencies: ["vitest", "@vitest/browser-playwright"]
        }
      ]
    },
    languageOptions: {
      parser: await import("jsonc-eslint-parser")
    }
  }
];
