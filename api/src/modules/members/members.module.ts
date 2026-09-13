import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { MembersController } from './members.controller';
import { MembersService } from './members.service';
import { DingTalkAdapterModule } from '../project/adapters/dingtalk-adapter.module';
import { LegalResponsibilityService } from './legal-responsibility.service';

@Module({
  imports: [PrismaModule, DingTalkAdapterModule],
  controllers: [MembersController],
  providers: [MembersService, LegalResponsibilityService],
})
export class MembersModule {}
