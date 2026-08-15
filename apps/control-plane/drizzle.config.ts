import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  out: "./migrations/generated",
  schema: "./src/database/schema.ts",
  strict: true,
  verbose: true,
});
