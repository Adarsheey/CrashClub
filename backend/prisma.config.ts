import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'prisma/config';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)) });

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: process.env.DATABASE_URL ?? '' },
});
