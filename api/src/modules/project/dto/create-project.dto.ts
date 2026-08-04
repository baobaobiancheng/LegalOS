import { IsString, IsNotEmpty, IsOptional, IsIn, MinLength, MaxLength } from 'class-validator';
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
  @MinLength(10)
  @MaxLength(5000)
  input: string; // 用户第一条消息内容

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
}

export class CreateProjectMessageDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(5000)
  text: string;

  @IsOptional()
  @IsString()
  @IsIn(['user', 'assistant', 'legal'])
  role?: string; // 默认 user
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
