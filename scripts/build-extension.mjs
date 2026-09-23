import { build } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";
await mkdir("extension/dist", { recursive: true });
await mkdir("artifacts", { recursive: true });
await copyFile("LICENSE", "extension/LICENSE");
await build({
  entryPoints: ["extension/src/extension.ts"],
  outfile: "extension/dist/extension.cjs",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  external: ["vscode"],
  sourcemap: false,
  legalComments: "eof",
  minify: false,
});
