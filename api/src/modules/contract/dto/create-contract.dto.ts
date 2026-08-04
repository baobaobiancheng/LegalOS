import {
  IsString,
  IsNotEmpty,
  IsOptional,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class ContractElementsDto {
  @IsOptional()
  @IsString()
  @MaxLength(256)
  partyA?: string; // 我方主体（默认当前用户公司）

  @IsOptional()
  @IsString()
  @MaxLength(256)
  partyB?: string; // 对方主体

  @IsOptional()
  @IsString()
  @MaxLength(256)
  amount?: string; // 金额

  @IsOptional()
  @IsString()
  @MaxLength(256)
  term?: string; // 期限

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  clauses?: string; // 主要条款/特殊要求

  // ⚠️ 模板升级新增要素（2026-08-03）：ValidationPipe whitelist 会剥离未定义字段，
  // 必须显式声明，否则动态表单提交的新字段会被静默丢弃
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  serviceContent?: string; // ai-service 服务内容 / tech-dev 开发内容

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  settlement?: string; // ai-service 结算方式

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  specialClauses?: string; // 特殊条款（通用）

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  confidentialScope?: string; // nda 保密信息范围

  @IsOptional()
  @IsString()
  @MaxLength(256)
  projectName?: string; // tech-dev 项目名称

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  payment?: string; // tech-dev 经费与支付方式

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  deliverable?: string; // tech-dev 交付物与验收

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  ipOwnership?: string; // tech-dev 知识产权

  // 主体详细信息（ai-service 表单 details 分组，缺一不可否则 whitelist 剥离）
  @IsOptional()
  @IsString()
  @MaxLength(512)
  partyAAddress?: string; // 甲方通讯地址

  @IsOptional()
  @IsString()
  @MaxLength(128)
  partyARepresentative?: string; // 甲方授权代表

  @IsOptional()
  @IsString()
  @MaxLength(128)
  partyAContact?: string; // 甲方经办人

  @IsOptional()
  @IsString()
  @MaxLength(64)
  partyATel?: string; // 甲方联系电话

  @IsOptional()
  @IsString()
  @MaxLength(128)
  partyAEmail?: string; // 甲方电子邮件

  @IsOptional()
  @IsString()
  @MaxLength(512)
  partyBAddress?: string; // 乙方通讯地址

  @IsOptional()
  @IsString()
  @MaxLength(128)
  partyBContact?: string; // 乙方联系人

  @IsOptional()
  @IsString()
  @MaxLength(64)
  partyBTel?: string; // 乙方联系电话
}

export class CreateContractDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  templateSlug: string; // 对应 ContractTemplate.slug

  @IsOptional()
  @ValidateNested()
  @Type(() => ContractElementsDto)
  elements?: ContractElementsDto;

  @IsOptional()
  @IsString()
  projectId?: string; // 已有合同工单内继续生成
}
