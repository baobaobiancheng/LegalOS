import { Global, Module } from '@nestjs/common';
import { BaijianMcpClientService } from './baijian-mcp-client.service';
import { BaijianResultNormalizer } from './baijian-result.normalizer';
import { CachedLegalResearchGateway } from './cached-legal-research.gateway';
import { LegalEvidenceRepository } from './legal-evidence.repository';

@Global()
@Module({
  providers: [BaijianMcpClientService, BaijianResultNormalizer, LegalEvidenceRepository, CachedLegalResearchGateway],
  exports: [BaijianMcpClientService, BaijianResultNormalizer, CachedLegalResearchGateway],
})
export class BaijianModule {}
