// SPIKE (#80 phase 0) — throwaway.
import { Module } from '@nestjs/common';
import { CollabGateway } from './collab.gateway.js';

@Module({ providers: [CollabGateway] })
export class CollabModule {}
