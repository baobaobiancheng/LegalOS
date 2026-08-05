import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { MembersController } from './members.controller';
import { MembersService } from './members.service';
import { DingTalkAdapterModule } from '../project/adapters/dingtalk-adapter.module';

@Module({
  imports: [PrismaModule, DingTalkAdapterModule],
  controllers: [MembersController],
  providers: [MembersService],
})
export class MembersModule {}
