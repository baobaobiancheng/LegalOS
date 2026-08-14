import { Global, Module } from '@nestjs/common';
import { BaijianMcpClientService } from './baijian-mcp-client.service';
import { BaijianResultNormalizer } from './baijian-result.normalizer';

@Global()
@Module({
  providers: [BaijianMcpClientService, BaijianResultNormalizer],
  exports: [BaijianMcpClientService, BaijianResultNormalizer],
})
export class BaijianModule {}
