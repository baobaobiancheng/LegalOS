import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { UnprocessableEntityException } from '@nestjs/common';
import { processContractFileInline } from './contract-file.processor';

interface ContractFileWorkerInput {
  filePath: string;
  originalName: string;
}

const port = parentPort;

if (!isMainThread && port) {
  const input = workerData as ContractFileWorkerInput;
  void processContractFileInline(input.filePath, input.originalName)
    .then((result) => port.postMessage({ ok: true, result }))
    .catch((error: unknown) => {
      if (error instanceof UnprocessableEntityException) {
        const response = error.getResponse();
        const message = typeof response === 'object' && response !== null
          ? String((response as Record<string, unknown>).error ?? '文件校验失败')
          : '文件校验失败';
        port.postMessage({ ok: false, errorType: 'validation', message });
        return;
      }
      port.postMessage({ ok: false, errorType: 'internal' });
    });
}
