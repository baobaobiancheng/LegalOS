import { IsString, IsOptional, IsIn } from 'class-validator';
import { ProjectStatus, RiskLevel } from '@prisma/client';

export class UpdateProjectDto {
  @IsOptional()
  @IsString()
  @IsIn(['分析中', '待处理', '待复核', '已回传', '已取消'])
  status?: ProjectStatus;

  @IsOptional()
  @IsString()
  @IsIn(['P0', 'P1', 'P2'])
  risk?: RiskLevel;

  @IsOptional()
  @IsString()
  ownerId?: string;

  @IsOptional()
  @IsString()
  legalBpId?: string;

  @IsOptional()
  @IsString()
  @IsIn(['llm', 'legalbp'])
  route?: string;

  @IsOptional()
  @IsString()
  result?: string;
}
