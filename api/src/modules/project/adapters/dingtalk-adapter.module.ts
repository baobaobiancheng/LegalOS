import { Module } from '@nestjs/common';
import { MockDingTalkAdapter } from './mock-dingtalk.adapter';
import { DingTalkAdapterImpl } from './dingtalk.adapter';
import { DINGTALK_ADAPTER } from './adapter.interfaces';

/**
 * 钉钉适配器公共模块（/review 2026-08-05 抽取）：
 * ProjectModule 与 MembersModule 共用同一实例——token 缓存单例共享，
 * 避免两模块各自 new 适配器导致重复 gettoken / 401 双刷新。
 */
@Module({
  providers: [
    {
      provide: DINGTALK_ADAPTER,
      useFactory: () =>
        process.env.DINGTALK_MOCK === 'true'
          ? new MockDingTalkAdapter()
          : new DingTalkAdapterImpl(),
    },
  ],
  exports: [DINGTALK_ADAPTER],
})
export class DingTalkAdapterModule {}
