import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/** 豁免全局 JwtAuthGuard，用于 /login、/refresh 等公开端点 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
