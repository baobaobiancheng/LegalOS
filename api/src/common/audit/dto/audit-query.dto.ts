import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class AuditQueryDto {
  @IsOptional() @IsString() action?: string;
  @IsOptional() @IsString() actorId?: string;
  @IsOptional() @IsString() resourceType?: string;
  @IsOptional() @IsString() resourceId?: string;
  @IsOptional() @IsString() projectId?: string;
  @IsOptional() @IsString() requestId?: string;
  @IsOptional() @IsString() correlationId?: string;
  @IsOptional() @IsIn(['success', 'denied', 'failed', 'partial']) outcome?: string;
  @IsOptional() @IsString() reasonCode?: string;
  @IsOptional() @IsString() from?: string;
  @IsOptional() @IsString() to?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) size = 20;
}
