import { realpath } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';
import { abortable, throwIfAborted } from './cancel.mjs';

export function containsPath(root, target) {
  const rel = relative(root, target);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`));
}

/** Lexically safe repo selections must also stay inside the session after symlinks. */
export async function canonicalDirectory(base, target, signal) {
  throwIfAborted(signal);
  const [root, directory] = await abortable(Promise.all([realpath(base), realpath(target)]), signal);
  if (!containsPath(root, directory)) throw new Error('Selected repository escapes the session working directory through a symlink');
  return directory;
}
