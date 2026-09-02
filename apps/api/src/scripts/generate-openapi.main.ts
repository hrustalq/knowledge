// Entry point: emit the OpenAPI schema WITHOUT starting an HTTP server.
// Run via `make api-schema` → node --env-file=apps/api/.env dist/scripts/generate-openapi.main.js --out openapi.json
// The Nest app is created (DI graph resolved, route metadata scanned) but never
// init()-ed or listen()-ed, so no lifecycle hooks fire and no infra is required
// beyond a valid env file (zod fail-fast still applies, on purpose).
import { NestFactory } from '@nestjs/core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { AppModule } from '../app.module.js';
import { createOpenApiDocument } from '../config/swagger.js';

async function main(): Promise<void> {
  const outFlag = process.argv.indexOf('--out');
  const out = resolve(outFlag > -1 && process.argv[outFlag + 1] ? process.argv[outFlag + 1] : 'openapi.json');

  const app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
  const doc = createOpenApiDocument(app);

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`✔ OpenAPI schema → ${out} (${Object.keys(doc.paths).length} paths, ${Object.keys(doc.components?.schemas ?? {}).length} schemas)`);

  await app.close();
  process.exit(0); // BullMQ/ioredis keep handles open — exit explicitly
}

main().catch((err) => {
  console.error('✖ OpenAPI generation failed:', err);
  process.exit(1);
});
