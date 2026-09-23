import tseslint from "typescript-eslint";
export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "extension/dist/**",
      "artifacts/**",
      ".vscode-test/**",
    ],
  },
  ...tseslint.configs.recommended,
);
