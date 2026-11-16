import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

/**
 * Replace one file atomically.
 *
 * The temporary file lives beside the destination so renameSync stays on the
 * same filesystem. SIGINT/SIGTERM can leave only an unreferenced temporary
 * file; the destination is always either the old complete file or the new one.
 */
export function atomicWriteFileSync(destination, data, options = 'utf8') {
  const parent = dirname(destination);
  const temporary = join(
    parent,
    `.${basename(destination)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  );
  const mode = existsSync(destination) ? statSync(destination).mode & 0o777 : 0o666;
  let fileDescriptor;

  try {
    fileDescriptor = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      mode
    );
    writeFileSync(fileDescriptor, data, options);
    fsyncSync(fileDescriptor);
    closeSync(fileDescriptor);
    fileDescriptor = undefined;
    renameSync(temporary, destination);

    // Persist the directory entry where the platform supports directory fsync.
    let directoryDescriptor;
    try {
      directoryDescriptor = openSync(parent, constants.O_RDONLY);
      fsyncSync(directoryDescriptor);
    } catch {
      // Some filesystems do not permit fsync on a directory.
    } finally {
      if (directoryDescriptor !== undefined) closeSync(directoryDescriptor);
    }
  } finally {
    if (fileDescriptor !== undefined) closeSync(fileDescriptor);
    rmSync(temporary, { force: true });
  }
}
