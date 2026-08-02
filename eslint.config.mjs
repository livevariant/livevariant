import nx from "@nx/eslint-plugin";

export default [
  ...nx.configs["flat/base"],
  ...nx.configs["flat/typescript"],
  ...nx.configs["flat/javascript"],
  {
    ignores: [
      "**/dist",
      "**/build",
      "**/vite.config.*.timestamp*",
      "**/vitest.config.*.timestamp*"
    ]
  },
  {
    files: [
      "**/*.ts",
      "**/*.cts",
      "**/*.mts",
      "**/*.js",
      "**/*.cjs",
      "**/*.mjs"
    ],
    rules: {
      "@nx/enforce-module-boundaries": [
        "error",
        {
          enforceBuildableLibDependency: true,
          allow: ["^.*/eslint(\\.base)?\\.config\\.[cm]?[jt]s$"],
          depConstraints: [
            {
              sourceTag: "*",
              onlyDependOnLibsWithTags: ["*"]
            }
          ]
        }
      ]
    }
  }
];
