import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { RequestIdInterceptor } from './common/interceptors/request-id.interceptor';

/**
 * CAS 启动强校验（T4）：生产/预发(CAS_ENFORCED)配置错误 → 拒绝启动,不在登录时 500。
 * - 生产禁止 CAS_BYPASS(mock)
 * - CAS_ENFORCED 环境:必须配 CAS_HOST(https) + 禁止 BYPASS
 */
function assertStartupConfig() {
  const env = process.env;
  const isProd = env.NODE_ENV === 'production';
  const enforced = env.CAS_ENFORCED === 'true';

  if (env.CAS_BYPASS === 'true' && isProd) {
    throw new Error('[config] CAS_BYPASS 在生产环境禁止启用（安全门禁）');
  }
  if (enforced) {
    if (!env.CAS_HOST || !/^https?:\/\//.test(env.CAS_HOST)) {
      throw new Error('[config] CAS_ENFORCED=true 但 CAS_HOST 缺失或非法');
    }
    if (env.CAS_BYPASS === 'true') {
      throw new Error('[config] CAS_ENFORCED 环境不允许启用 CAS_BYPASS');
    }
  }
}

async function bootstrap() {
  assertStartupConfig();
  const app = await NestFactory.create(AppModule);

  app.setGlobalPrefix('api');
  app.use(cookieParser());
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true }),
  );
  // P2-03：请求 ID(响应头 X-Request-ID + 错误体 requestId);先于过滤器,异常路径也能拿到 ID
  app.useGlobalInterceptors(new RequestIdInterceptor());
  app.useGlobalFilters(new HttpExceptionFilter());

  // 前端 Vite dev server 需携带 cookie
  app.enableCors({
    origin: process.env.WEB_ORIGIN || 'http://localhost:5173',
    credentials: true,
  });

  const port = Number(process.env.PORT || 3000);
  await app.listen(port);
  console.log(`法务AI平台 API 已启动：http://localhost:${port}/api`);
}

bootstrap();
