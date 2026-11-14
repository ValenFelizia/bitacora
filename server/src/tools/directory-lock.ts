import koffi from 'koffi';
import { openSync, closeSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// Windows directory handles, not a cooperative lock file: another process cannot
// replace the locked directory or set a reparse point while these handles exist.
const kernel = koffi.load('kernel32.dll');
const create = kernel.func('void * __stdcall CreateFileW(str16, uint32, uint32, void *, uint32, uint32, void *)');
const info = kernel.func('int __stdcall GetFileInformationByHandleEx(void *, int, void *, uint32)');
const close = kernel.func('int __stdcall CloseHandle(void *)');
const lastError = kernel.func('uint32 __stdcall GetLastError()');

function lockPath(path: string, directory: boolean, share = directory ? 1 : 3): () => void {
  const handle = create(path, 0x80000000, share, null, 3, 0x02200000, null);
  if (!handle || koffi.address(handle) === 0xffffffffffffffffn) throw new Error(`No pude proteger la carpeta durante la escritura (Windows ${lastError()}). Volvé a intentarlo.`);
  const attributes = Buffer.alloc(8);
  if (!info(handle, 9, attributes, attributes.length) || !!(attributes.readUInt32LE(0) & 0x10) !== directory || (attributes.readUInt32LE(0) & 0x400)) {
    close(handle);
    throw new Error('No se permiten enlaces ni cambios de ubicación durante la escritura.');
  }
  return () => { close(handle); };
}
export function lockDirectory(path: string) {
  const strong = lockPath(path,true);
  const sentinel = join(path, `.kit-guard-${randomUUID()}`);
  let fd: number | undefined, file: (()=>void) | undefined, directory: (()=>void) | undefined;
  try {
    fd = openSync(sentinel,'wx');
    file = lockPath(sentinel,false);
    directory = lockPath(path,true,3);
    closeSync(fd); fd = undefined;
  } catch(e) {
    if (fd !== undefined) closeSync(fd);
    file?.(); directory?.();
    try { unlinkSync(sentinel); } catch {}
    throw e;
  } finally { strong(); }
  // No DELETE sharing prevents directory replacement. The non-removable sentinel
  // keeps the directory nonempty, so NTFS cannot turn it into a junction in place.
  // WRITE sharing is necessary for our own rename/link publication operations.
  return () => { try { file!(); unlinkSync(sentinel); } finally { directory!(); } };
}
export const lockTemporaryFile = (path: string) => lockPath(path, false);

