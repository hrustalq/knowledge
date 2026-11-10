import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PlaudOauthService } from './plaud-oauth.service.js';

/** Plaud (#864), controller-free: the sign-in every Plaud call dials with. */
@Module({
  imports: [PrismaModule],
  providers: [PlaudOauthService],
  exports: [PlaudOauthService],
})
export class PlaudCoreModule {}
