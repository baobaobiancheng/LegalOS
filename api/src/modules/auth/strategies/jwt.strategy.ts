import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../../../prisma/prisma.service';

export type JwtPayload = { sub: string; role: string; type: 'access' };

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('JWT_SECRET'),
    });
  }

  /** 验签通过后查库确认用户仍启用（设计文档 GET /me 要求） */
  async validate(payload: JwtPayload) {
    if (payload.type !== 'access') {
      throw new UnauthorizedException({
        error: 'token 类型无效',
        code: 'UNAUTHORIZED',
      });
    }

    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || !user.isActive) {
      throw new UnauthorizedException({
        error: '用户已禁用或 token 无效',
        code: 'UNAUTHORIZED',
      });
    }

    return {
      id: user.id,
      username: user.username,
      role: user.role,
      displayName: user.displayName,
    };
  }
}
