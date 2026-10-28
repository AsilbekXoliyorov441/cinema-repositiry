import 'dotenv/config';
import { defineConfig } from 'prisma/config';

// With a config file present Prisma no longer auto-loads .env, hence the dotenv import above.
// In containers the variables come from the environment and no .env file is needed.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
});
