import { fileURLToPath } from 'node:url';
import type { Config } from 'drizzle-kit';

export default {
  dialect: 'postgresql',
  schema: fileURLToPath(new URL('./schema.js', import.meta.url)),
  casing: 'snake_case',
  schemaFilter: ['coder'],
  dbCredentials: { url: process.env.DATABASE_URL! },
} satisfies Config;
