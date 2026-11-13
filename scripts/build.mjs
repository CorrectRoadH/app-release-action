import { build } from "esbuild";
await build({
  entryPoints: {
    index: "src/index.ts",
    post: "src/post.ts",
    artifact: "src/artifact-main.ts",
  },
  outdir: "dist",
  outExtension: { ".js": ".cjs" },
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  sourcemap: false,
  legalComments: "eof",
  metafile: false,
});
