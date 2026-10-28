import { writeFile } from 'node:fs/promises';
import { createApp } from '../app.js';
import { buildOpenApiDocument } from '../docs/swagger.js';
import { prisma } from '../config/database.js';
import { redis } from '../config/redis.js';

/** Writes openapi.json (e.g. for client generation or API review). Routes register their docs on import. */
createApp();
const out = process.argv[2] ?? 'openapi.json';
await writeFile(out, JSON.stringify(buildOpenApiDocument(), null, 2));
console.log(`✔ OpenAPI document written to ${out}`);
await prisma.$disconnect();
redis.disconnect();
