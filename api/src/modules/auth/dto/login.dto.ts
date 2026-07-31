import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class LoginDto {
  @IsString()
  @IsNotEmpty({ message: '用户名不能为空' })
  @MaxLength(64)
  username: string;

  @IsString()
  @IsNotEmpty({ message: '密码不能为空' })
  @MaxLength(128)
  password: string;
}
