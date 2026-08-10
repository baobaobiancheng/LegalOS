import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/** CAS 登录入参（T3）：只收 ticket。service 不存在于本公司 CAS（源码确认）,无需传。 */
export class CasLoginDto {
  @IsString()
  @IsNotEmpty({ message: 'ticket 不能为空' })
  @MaxLength(64)
  ticket: string;
}
