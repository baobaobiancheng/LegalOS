import { Transform } from 'class-transformer';
import { IsIn, IsOptional } from 'class-validator';

export class DashboardQueryDto {
  @IsOptional()
  @Transform(({ value }) => value === undefined ? 30 : Number(value))
  @IsIn([7, 30])
  days: 7 | 30 = 30;
}
