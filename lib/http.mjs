import { ApiError } from './gduf.mjs';

const maxBodyBytes = 64 * 1024;

export async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBodyBytes) {
      throw new ApiError('请求内容过大。', 413, 'PAYLOAD_TOO_LARGE');
    }
    chunks.push(chunk);
  }

  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ApiError('请求格式不正确。');
  }
}

export function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(body);
}

export function sendError(res, error) {
  const status = error instanceof ApiError ? error.status : 500;
  const code = error instanceof ApiError ? error.code : 'INTERNAL_ERROR';
  const message = error instanceof ApiError ? error.message : '服务器内部错误。';
  if (status >= 500) console.error(error);
  sendJson(res, status, { error: message, code });
}
