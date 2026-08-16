import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/canonical-json.ts",
    "src/completion.ts",
    "src/credential-safety.ts",
  ],
  format: ["esm"],
  bundle: false,
  sourcemap: true,
  clean: true,
});
