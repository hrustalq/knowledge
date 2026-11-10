import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PlaudOauthService } from './plaud-oauth.service.js';
import { PlaudService } from './plaud.service.js';

/** Plaud (#864), controller-free: the sign-in every Plaud call dials with, and the reads made with it. */
@Module({
  imports: [PrismaModule],
  providers: [PlaudOauthService, PlaudService],
  exports: [PlaudOauthService, PlaudService],
})
export class PlaudCoreModule {}
