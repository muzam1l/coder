import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/server/store/pg/schema.ts',
  out: './migrations',
  casing: 'snake_case',
  schemaFilter: ['coder'],
  ...(process.env.DATABASE_URL ? { dbCredentials: { url: process.env.DATABASE_URL } } : {}),
});
