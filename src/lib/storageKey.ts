import { randomUUID } from 'node:crypto';

/**
 * A storage key for an uploaded chat file: the client's date folder, then a random id, then the
 * file name (kept so the extension and voice note names still read correctly).
 */
export function uniqueStorageKey(clientKey: string | undefined, name: string | undefined, id: string = randomUUID()): string {
  const key = String(clientKey ?? '');
  const slash = key.lastIndexOf('/');
  const dir = slash > 0 ? key.slice(0, slash) : '';
  const base = String(name || (slash >= 0 ? key.slice(slash + 1) : key) || 'file').replace(/[\\/]/g, '_');
  return `${dir ? `${dir}/` : ''}${id}-${base}`;
}
