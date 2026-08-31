export const CRM_A1_PATH = '/api/crm/v1/contract-tasks';
export const CRM_A1_MAX_FILE_BYTES = 20 * 1024 * 1024;
export const CRM_A1_MAX_REQUEST_BYTES = 100 * 1024 * 1024;
export const CRM_A1_MAX_FILES = 10;
export const CRM_A1_MAX_ATTACHMENTS = 5;
export const CRM_A1_MAX_REVIEW_CHARS = 100_000;

export type CrmFilePartName = 'files' | 'attachments' | 'mainContractFile';

export interface CrmA1Headers {
  appId: string;
  timestamp: number;
  nonce: string;
  idempotencyKey: string;
  payloadSha256: string;
  fileManifestSha256: string;
  signature: string;
}

export interface CrmReceivedFile {
  partName: CrmFilePartName;
  index: number;
  originalName: string;
  mimeType: string;
  size: number;
  sha256: string;
  storedName: string;
  path: string;
}

export interface CrmFileManifestItem {
  partName: CrmFilePartName;
  index: number;
  originalName: string;
  size: number;
  sha256: string;
}

export interface CrmMultipartEnvelope {
  payloadText: string;
  payloadSha256: string;
  fileManifest: CrmFileManifestItem[];
  fileManifestSha256: string;
  files: CrmReceivedFile[];
  stagingDir: string;
}
