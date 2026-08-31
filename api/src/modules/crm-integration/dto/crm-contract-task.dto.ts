import { plainToInstance, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
  validate,
} from 'class-validator';
import { HttpStatus } from '@nestjs/common';
import { crmA1Error } from '../crm-a1.errors';

class CrmAuditHistoryItemDto {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  node!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  assignee!: string;

  @IsString()
  @MaxLength(2000)
  opinion!: string;

  @IsISO8601({ strict: true })
  time!: string;
}

export class CrmContractTaskPayloadDto {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  crmTaskId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  contractNo!: string;

  @IsIn(['NEW', 'RENEW', 'CHANGE'])
  contractApplyType!: 'NEW' | 'RENEW' | 'CHANGE';

  @IsIn(['NORMAL', 'SUPPLEMENT'])
  contractType!: 'NORMAL' | 'SUPPLEMENT';

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  currentAuditStatus!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  currentAuditNode!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  currentNodeAssignee!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  applicant!: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => CrmAuditHistoryItemDto)
  auditHistory?: CrmAuditHistoryItemDto[];

  @IsString()
  @MinLength(1)
  @MaxLength(256)
  customerName!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(256)
  signSubject!: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  productType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  relatedBizInfo?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  bizRemark?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  contractStartDate?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  contractEndDate?: string;

  @IsOptional()
  @IsBoolean()
  useOurTemplate?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  fileVersion?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  mainContractNo?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  mainContractUrl?: string;
}

export async function parseCrmContractTaskPayload(payloadText: string): Promise<CrmContractTaskPayloadDto> {
  let raw: unknown;
  try {
    raw = JSON.parse(payloadText);
  } catch {
    throw crmA1Error(HttpStatus.BAD_REQUEST, 'INVALID_PARAM', 'payload 必须是合法 JSON');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw crmA1Error(HttpStatus.BAD_REQUEST, 'INVALID_PARAM', 'payload 必须是 JSON 对象');
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'sourceAppId')) {
    throw crmA1Error(HttpStatus.BAD_REQUEST, 'INVALID_PARAM', 'sourceAppId 只能由服务端从 X-App-Id 派生');
  }

  trimStringFields(raw);
  const dto = plainToInstance(CrmContractTaskPayloadDto, raw);
  const errors = await validate(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
    stopAtFirstError: false,
  });
  if (errors.length) {
    const message = flattenValidationErrors(errors).slice(0, 6).join('；');
    throw crmA1Error(HttpStatus.BAD_REQUEST, 'INVALID_PARAM', message || 'payload 字段校验失败');
  }

  assertDate(dto.contractStartDate, 'contractStartDate');
  assertDate(dto.contractEndDate, 'contractEndDate');
  if (dto.contractStartDate && dto.contractEndDate && dto.contractStartDate > dto.contractEndDate) {
    throw crmA1Error(HttpStatus.BAD_REQUEST, 'INVALID_PARAM', 'contractStartDate 不能晚于 contractEndDate');
  }
  if (dto.mainContractUrl) {
    try {
      const url = new URL(dto.mainContractUrl);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('unsupported protocol');
    } catch {
      throw crmA1Error(HttpStatus.BAD_REQUEST, 'INVALID_PARAM', 'mainContractUrl 必须是 http/https URL');
    }
  }
  return dto;
}

function trimStringFields(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === 'string') (value as Record<string, unknown>)[key] = item.trim();
    else if (Array.isArray(item)) item.forEach(trimStringFields);
    else trimStringFields(item);
  }
}

function assertDate(value: string | undefined, field: string): void {
  if (!value) return;
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw crmA1Error(HttpStatus.BAD_REQUEST, 'INVALID_PARAM', `${field} 不是合法日期`);
  }
}

function flattenValidationErrors(errors: any[], prefix = ''): string[] {
  return errors.flatMap((error) => {
    const path = prefix ? `${prefix}.${error.property}` : error.property;
    const own = Object.values(error.constraints ?? {}).map((message) => `${path}: ${message}`);
    return [...own, ...flattenValidationErrors(error.children ?? [], path)];
  });
}
