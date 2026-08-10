import { Module, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CAS_ADAPTER } from './cas-adapter.interface';
import { MockCasAdapter } from './mock-cas.adapter';
import { RealCasAdapter } from './real-cas.adapter';

/**
 * CAS 适配器模块（T2）：CAS_BYPASS=true 且非生产 → mock；否则真实适配器。
 * 生产启用 mock 会在 fail-fast（main.ts assertStartupConfig）拒绝启动。
 */
@Module({
  providers: [
    {
      provide: CAS_ADAPTER,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const bypass = config.get<string>('CAS_BYPASS') === 'true';
        const isProd = config.get<string>('NODE_ENV') === 'production';
        if (bypass && !isProd) {
          new Logger('CasAdapterModule').warn('CAS_BYPASS=true：使用 Mock CAS 适配器（仅本地调试）');
          return new MockCasAdapter();
        }
        return new RealCasAdapter(config);
      },
    },
  ],
  exports: [CAS_ADAPTER],
})
export class CasAdapterModule {}
