import { createHash } from 'node:crypto';
import { GraphError } from './errors.ts';
export const MIME_LIMITS: Record<string, number> = {
  'image/jpeg': 5 * 1024 ** 2,
  'image/png': 5 * 1024 ** 2,
  'image/webp': 500 * 1024,
  'audio/aac': 16 * 1024 ** 2,
  'audio/amr': 16 * 1024 ** 2,
  'audio/mpeg': 16 * 1024 ** 2,
  'audio/mp4': 16 * 1024 ** 2,
  'audio/ogg': 16 * 1024 ** 2,
  'video/mp4': 16 * 1024 ** 2,
  'video/3gpp': 16 * 1024 ** 2,
  'text/plain': 100 * 1024 ** 2,
  'application/pdf': 100 * 1024 ** 2,
  'application/msword': 100 * 1024 ** 2,
  'application/vnd.ms-excel': 100 * 1024 ** 2,
  'application/vnd.ms-powerpoint': 100 * 1024 ** 2,
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 100 * 1024 ** 2,
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 100 * 1024 ** 2,
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 100 * 1024 ** 2,
};
export function mediaRecord(
  id: string,
  bytes: Uint8Array,
  mime: string,
  filename: string,
  phoneId: string,
  now: number,
) {
  mime = mime.split(';')[0]!.trim().toLowerCase();
  if (!MIME_LIMITS[mime]) throw new GraphError(100, 'Unsupported media MIME type');
  if (!bytes.length || bytes.length > MIME_LIMITS[mime])
    throw new GraphError(131053, 'Media size is outside the supported limit');
  return {
    id,
    mime_type: mime,
    file_size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    filename: filename.replace(/[\r\n"\\]/g, '_'),
    phone_number_id: phoneId,
    created_at: now,
    data: Buffer.from(bytes).toString('base64'),
  };
}
export function mimeMatches(type: string, mime: string) {
  return type === 'document'
    ? !!MIME_LIMITS[mime]
    : type === 'sticker'
      ? mime === 'image/webp'
      : mime.startsWith(type + '/') && mime !== 'image/webp';
}
