import { IsString, IsNotEmpty, Matches, MaxLength } from 'class-validator';

/** 手动绑定：系统用户 ↔ 钉钉通讯录成员 */
export class BindContactDto {
  @IsString()
  @IsNotEmpty()
  userId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  dingtalkUserId!: string;
}

/** 管理员预开通：以 CAS 账号为身份键，同时绑定一个未占用的钉钉联系人。 */
export class ProvisionMemberDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  @Matches(/^[A-Za-z0-9._-]+$/, { message: 'CAS 账号格式不正确' })
  casUsername!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  dingtalkUserId!: string;
}
