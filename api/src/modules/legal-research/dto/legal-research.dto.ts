import { IsBoolean, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
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
