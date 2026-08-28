import { Role } from '@prisma/client';

export class PublicUserDto {
  id: string;
  username: string;
  role: Role;
  displayName: string;
  avatarUrl: string | null;
}

export class LoginResponseDto {
  accessToken: string;
  user: PublicUserDto;
}

export class RefreshResponseDto {
  accessToken: string;
}
