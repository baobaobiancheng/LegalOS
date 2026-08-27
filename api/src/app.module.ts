import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { AuthModule } from './modules/auth/auth.module';
import { ProjectModule } from './modules/project/project.module';
import { ContractModule } from './modules/contract/contract.module';
import { SkillModule } from './modules/skill/skill.module';
import { MembersModule } from './modules/members/members.module';
import { PrismaModule } from './prisma/prisma.module';
import { CodexModule } from './common/services/codex.module';
import { DshModule } from './common/services/dsh.module';
import { ConsultationChatModule } from './common/services/consultation-chat.module';
import { BaijianModule } from './common/baijian/baijian.module';
import { AiExecutionModule } from './common/services/ai-execution.module';
import { LegalResearchModule } from './modules/legal-research/legal-research.module';
import { AuditModule } from './common/audit/audit.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
    PrismaModule,
    AuditModule,
    AiExecutionModule,
    CodexModule,
    DshModule,
    BaijianModule,
    ConsultationChatModule,
    AuthModule,
    ProjectModule,
    ContractModule,
    SkillModule,
    MembersModule,
    LegalResearchModule,
  ],
  providers: [
    // 顺序即执行顺序：限流 → 认证 → 授权
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
