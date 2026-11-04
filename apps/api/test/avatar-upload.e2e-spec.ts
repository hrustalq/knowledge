import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { StorageService } from '../src/storage/storage.service.js';
import { createE2eApp } from './e2e-app.js';

/** Against real object storage: a bound upload URL takes the declared type and no other. Needs `make infra-up`. */
describe('avatar upload URL (e2e)', () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await createE2eApp();
  }, 60_000);
  afterAll(async () => {
    await app?.close();
  });

  it('refuses a PUT under any type but the one it was signed for', async () => {
    const storage = app.get(StorageService);
    const key = `e2e/${randomUUID()}.png`;
    const url = await storage.presignPut(key, 'image/png', 60, { bindContentType: true });
    const put = (type: string) => fetch(url, { method: 'PUT', headers: { 'Content-Type': type }, body: '<script>1</script>' });
    expect((await put('text/html')).status).toBe(403);
    expect(await storage.headObject(key)).toBeNull();
    expect((await put('image/png')).status).toBe(200);
    expect((await storage.headObject(key))?.contentType).toBe('image/png');
    await storage.deleteObject(key);
  });
});
