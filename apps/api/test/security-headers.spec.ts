import { describe, expect, it } from 'vitest';
import 'reflect-metadata';
import { Controller, Get, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { applySecurityHeaders } from '../src/common/security-headers.js';

// #1114: every API response says what it is and nothing about the framework.

@Controller('probe')
class ProbeController {
  @Get()
  get() {
    return { ok: true };
  }
}

@Module({ controllers: [ProbeController] })
class ProbeModule {}

describe('applySecurityHeaders', () => {
  it('drops X-Powered-By and sends nosniff, on a route and on a 404', async () => {
    const app = await NestFactory.create<NestExpressApplication>(ProbeModule, { logger: false });
    applySecurityHeaders(app);
    await app.init();
    try {
      for (const path of ['/probe', '/nowhere']) {
        const res = await request(app.getHttpServer()).get(path);
        expect(res.headers['x-powered-by']).toBeUndefined();
        expect(res.headers['x-content-type-options']).toBe('nosniff');
      }
    } finally {
      await app.close();
    }
  });
});
