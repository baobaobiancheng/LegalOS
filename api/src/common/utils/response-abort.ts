import { Response } from 'express';

/** 在异步排队前监听断开；回调建立 SSE 监听后移交取消职责。 */
export async function withResponseAbort(
  res: Response,
  start: (abort: AbortController) => Promise<void>,
): Promise<void> {
  const abort = new AbortController();
  const onClose = () => { if (!res.writableEnded) abort.abort(); };
  res.once('close', onClose);
  try {
    if (res.destroyed) return;
    await start(abort);
  } finally {
    res.off('close', onClose);
  }
}
