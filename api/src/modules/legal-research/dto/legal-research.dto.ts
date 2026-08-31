import { IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Transform, Type } from 'class-transformer';

class RefreshableResearchDto {
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true'
    ? true
    : value === false || value === 'false'
      ? false
      : value)
  @IsBoolean()
  refresh?: boolean;
}

export class SearchLawsDto extends RefreshableResearchDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  keyword: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  rows?: number;
}

export class SearchCasesDto extends RefreshableResearchDto {
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  query: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  topK?: number;
}

export class LawDetailParamsDto {
  @IsString()
  @Matches(/^[0-9a-f]{32}$/i)
  lawId: string;
}

export class LawDetailQueryDto extends RefreshableResearchDto {}

export class AiLawResearchDto {
  @IsString()
  @MinLength(2)
  @MaxLength(1000)
  query: string;

  /** 服务端持有的独立检索会话；首轮不传，由服务端创建。 */
  @IsOptional()
  @IsUUID()
  conversationId?: string;

  /** 客户端消息幂等键：只需稳定且可安全存储，不要求 UUID 语义。 */
  @IsOptional()
  @IsString()
  @MinLength(16)
  @MaxLength(128)
  @Matches(/^[A-Za-z0-9._:-]+$/)
  messageId?: string;

  /** 前端看到的上一轮 run id，用于拒绝在过期上下文上继续追问。 */
  @IsOptional()
  @IsUUID()
  parentTurnId?: string;

  /** 服务端上下文版本；不一致时返回 409，避免并发追问覆盖事实修正。 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  contextVersion?: number;

  /** auto 会按“不是/更正/改为”等措辞识别事实修正。 */
  @IsOptional()
  @IsIn(['auto', 'continue', 'correct', 'new_issue'])
  operation?: 'auto' | 'continue' | 'correct' | 'new_issue';
}

export class AiLawReportDownloadDto {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  reportId: string;

  @IsString()
  @Matches(/^(md|docx)$/)
  format: 'md' | 'docx';
}
