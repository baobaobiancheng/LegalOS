import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/** CAS 登录入参（T3 修订）：登录页表单账号密码,后端走 CAS 方式一(/api/login 换 ticket → validate)。 */
export class CasLoginDto {
  @IsString()
  @IsNotEmpty({ message: 'CAS 账号不能为空' })
  @MaxLength(128)
  username: string;

  @IsString()
  @IsNotEmpty({ message: '密码不能为空' })
  @MaxLength(128)
  password: string;
}
