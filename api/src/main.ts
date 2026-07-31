import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.setGlobalPrefix('api');
  app.use(cookieParser());
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true }),
  );
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
