import { IsString, IsNotEmpty, IsBoolean, Matches, MaxLength } from 'class-validator';
import { SKILL_GROUPS } from '../../../common/constants/skill.constants';

/** 手动绑定：系统用户 ↔ 钉钉通讯录成员 */
export class BindContactDto {
  @IsString()
  @IsNotEmpty()
  userId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  dingtalkUserId!: string;
}

/** 管理员预开通：以 CAS 账号为身份键，同时绑定一个未占用的钉钉联系人。 */
export class ProvisionMemberDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  @Matches(/^[A-Za-z0-9._-]+$/, { message: 'CAS 账号格式不正确' })
  casUsername!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  dingtalkUserId!: string;
}

/** BP 领域映射设置：为法务 BP 勾选/取消某个领域 */
export class SetBpDomainDto {
  @IsString()
  @IsNotEmpty()
  userId!: string;

  @IsString()
  @IsNotEmpty()
  domain!: string;

  @IsBoolean()
  enabled!: boolean;
}

/** 领域白名单 = SKILL_GROUPS 单一来源（/review 2026-08-05 统一，防多份拷贝漂移） */
export const BP_DOMAINS = SKILL_GROUPS;

/** DTO 领域白名单校验辅助 */
export function isBpDomain(d: string): boolean {
  return (BP_DOMAINS as readonly string[]).includes(d);
}
