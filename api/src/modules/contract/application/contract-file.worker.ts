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
        const validationError = typeof response === 'object' && response !== null
          ? String((response as Record<string, unknown>).error ?? '文件校验失败')
          : '文件校验失败';
        port.postMessage({ ok: false, validationError });
        return;
      }
      port.postMessage({
        ok: false,
        internalError: error instanceof Error ? error.message : '合同文件解析失败',
      });
    });
}
