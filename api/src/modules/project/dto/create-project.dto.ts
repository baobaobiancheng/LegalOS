import { IsString, IsNotEmpty, IsOptional, IsIn, IsBoolean, IsArray, MinLength, MaxLength, ArrayMaxSize } from 'class-validator';
import { ProjectKind } from '@prisma/client';
import { CONSULTATION_CAPABILITIES, ConsultationCapability } from '../domain/consultation-capability';

export class CreateProjectDto {
  @IsString()
  @IsNotEmpty()
  @IsIn(['consult', 'contract', 'research', 'draft'])
  kind: ProjectKind;

  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  title: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  input: string; // 用户第一条消息内容（咨询问题,2026-08-13 完全取消 ≥5 字限制,只留非空）

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

  // 咨询附件 id 列表（2026-08-12：multipart 上传后返回的 attachmentId）
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @IsString({ each: true })
  attachmentIds?: string[];

  @IsOptional()
  @IsIn(CONSULTATION_CAPABILITIES)
  capability?: ConsultationCapability;
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

  // 客户端幂等键（2026-08-12 多轮上下文改造）：前端每个问题生成一个 key，
  // 服务端按 clientKey 去重建消息（unique），再按消息 id 认领 ConsultationRun，
  // 防双重提交 / 网络重试产生重复消息与重复 AI 回答。
  @IsOptional()
  @IsString()
  @MaxLength(128)
  idempotencyKey?: string;

  // 咨询附件 id 列表（2026-08-12）
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @IsString({ each: true })
  attachmentIds?: string[];

  /** 本轮能力快照。服务端写入 ConsultationRun，重试时不允许改变。 */
  @IsOptional()
  @IsIn(CONSULTATION_CAPABILITIES)
  capability?: ConsultationCapability;
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
