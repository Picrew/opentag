import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/**/*.ts"],
  format: ["esm"],
  bundle: false,
  sourcemap: true,
  clean: true,
});
