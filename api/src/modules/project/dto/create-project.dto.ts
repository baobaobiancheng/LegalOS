import { IsString, IsNotEmpty, IsOptional, IsIn, IsBoolean, MinLength, MaxLength } from 'class-validator';
import { ProjectKind } from '@prisma/client';

export class CreateProjectDto {
  @IsString()
  @IsNotEmpty()
  @IsIn(['consult', 'contract', 'research', 'draft'])
  kind: ProjectKind;

  @IsString()
  @IsNotEmpty()
  @MinLength(5)
  @MaxLength(256)
  title: string;

  @IsString()
  @IsNotEmpty()
  @MinLength(5)
  @MaxLength(5000)
  input: string; // 用户第一条消息内容（咨询问题,review 2026-08-11 短推荐问题 10→5）

  @IsOptional()
  @IsString()
  skillId?: string;

  @IsOptional()
  @IsString()
  skillName?: string;

  @IsOptional()
  @IsString()
  requesterName?: string;

  @IsOptional()
  @IsString()
  requesterDepartment?: string;

  // CRM 上下文（可选，Adapter 自动带）
  @IsOptional()
  @IsString()
  crmReference?: string;

  // 幂等键（P1-03）：同一键只创建一个工单，防客户端/CRM 重试重复建单/建群
  @IsOptional()
  @IsString()
  @MaxLength(128)
  idempotencyKey?: string;
}

export class CreateProjectMessageDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(5000)
  text: string;
  // 消息 role 由服务端根据 actor 派生（P1-01 5.3.6）：不允许客户端伪造 assistant/legal

  // 首轮回答（review 2026-08-11 P0）：建单时首条用户消息已落库，此标记让 /messages
  // 只启动首轮 AI 回答，不再重复写入用户消息、不再重复风险评估。
  @IsOptional()
  @IsBoolean()
  firstReply?: boolean;
}

export class ReplyProjectDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(5000)
  text: string;
}

export class TransferProjectDto {
  @IsString()
  @IsNotEmpty()
  legalBpId: string;
}
