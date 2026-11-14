import { Module } from '@nestjs/common';
import { ImageProxyController } from './image-proxy.controller.js';

/** API-only (a controller): never import this into WorkerModule. */
@Module({ controllers: [ImageProxyController] })
export class ImageProxyModule {}
