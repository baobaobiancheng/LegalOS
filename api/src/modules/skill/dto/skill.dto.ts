import {
  IsString,
  IsNotEmpty,
  IsOptional,
  MaxLength,
  IsIn,
  Matches,
  IsBoolean,
  IsEnum,
} from 'class-validator';
import { SKILL_GROUPS, SKILL_PROMPT_MAX_LENGTH } from '../../../common/constants/skill.constants';
import { SkillVisibility } from '@prisma/client';

/** 注册技能（工程评审决策：默认 private；lead/admin 可直接 public） */
export class CreateSkillDto {
  /** 技能代号（可选：不传则由服务端 pinyin 自动生成；创建后不可变） */
  @IsOptional()
  @IsString()
  @Matches(/^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/, {
    message: 'slug 仅支持小写字母/数字/连字符',
  })
  @MaxLength(64)
  slug?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  name: string;

  @IsString()
  @IsIn(SKILL_GROUPS, { message: `group 必须是 6 组技能组之一：${SKILL_GROUPS.join('/')}` })
  group: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  description?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(SKILL_PROMPT_MAX_LENGTH, { message: `prompt 不能超过 ${SKILL_PROMPT_MAX_LENGTH} 字` })
  prompt: string;

  /** 仅 legal_lead/admin 可传 public（controller 层角色校验，普通 BP 传了也强制回 private） */
  @IsOptional()
  @IsEnum(SkillVisibility)
  visibility?: SkillVisibility;
}

/** 编辑技能（slug 不可修改；pending 状态不可编辑） */
export class UpdateSkillDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  name?: string;

  @IsOptional()
  @IsString()
  @IsIn(SKILL_GROUPS)
  group?: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  description?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(SKILL_PROMPT_MAX_LENGTH)
  prompt?: string;
}

/** 审核（驳回 reason 必填） */
export class ReviewSkillDto {
  @IsBoolean()
  approved: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  reason?: string;
}
