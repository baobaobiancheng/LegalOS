import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/** 从请求上下文取出 JwtStrategy.validate 注入的当前用户 */
export const CurrentUser = createParamDecorator(
  (data: string | undefined, ctx: ExecutionContext) => {
    const user = ctx.switchToHttp().getRequest().user;
    return data ? user?.[data] : user;
  },
);
