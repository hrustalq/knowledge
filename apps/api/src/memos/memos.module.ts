import { Module } from '@nestjs/common';
import { MemosCoreModule } from './memos-core.module.js';
import { MemosController } from './memos.controller.js';

/** Memos (#551), API side. Controller-bearing, so never imported by the worker. */
@Module({
  imports: [MemosCoreModule],
  controllers: [MemosController],
})
export class MemosModule {}
