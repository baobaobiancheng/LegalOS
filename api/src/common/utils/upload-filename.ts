/** 还原 Multer 的 Latin-1 文件名；保留已解码 Unicode 和真实 Latin-1 名称。 */
export function normalizeUploadFilename(raw: string): string {
  let name = raw;
  if ([...raw].every((character) => character.codePointAt(0)! <= 255)) {
    try {
      name = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(raw, 'latin1'));
    } catch {
      // 真正的 Latin-1 文件名不是 UTF-8 字节序列，保留原名。
    }
  }
  return name.replace(/[\x00-\x1f\x7f]/g, '').replace(/[\\/]+/g, '_').trim() || 'unnamed';
}
