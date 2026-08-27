import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class RecordDownloadDto {
  @IsIn(['contract', 'consultation_record'])
  resourceType!: 'contract' | 'consultation_record';

  @IsOptional()
  @IsString()
  @MaxLength(64)
  resourceId?: string;

  @IsIn(['md', 'docx'])
  format!: 'md' | 'docx';
}
