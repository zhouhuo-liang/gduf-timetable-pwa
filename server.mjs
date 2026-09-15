import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiError, createSession, fetchTimetable } from './lib/gduf.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const publicDir = join(__dirname, 'public');
const port = Number(process.env.PORT || 4173);
const maxBodyBytes = 64 * 1024;

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendText(res, status, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

async function readJsonBody(req) {
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

async function handleApi(req, res, pathname) {
  if (req.method === 'GET' && pathname === '/api/health') {
    return sendJson(res, 200, { ok: true, service: 'gduf-timetable-pwa' });
  }

  if (req.method === 'POST' && pathname === '/api/session') {
    const body = await readJsonBody(req);
    const studentId = String(body.studentId ?? '').trim();
    const password = String(body.password ?? '');
    if (!/^\d{6,20}$/.test(studentId)) {
      throw new ApiError('请输入正确的学号。');
    }
    if (!password) {
      throw new ApiError('请输入教务系统密码。');
    }

    const result = await createSession(studentId, password, body.week);
    return sendJson(res, 200, result);
  }

  if (req.method === 'POST' && pathname === '/api/timetable') {
    const body = await readJsonBody(req);
    const studentId = String(body.studentId ?? '').trim();
    const token = String(body.token ?? '').trim();
    if (!/^\d{6,20}$/.test(studentId) || !token) {
      throw new ApiError('缺少有效的登录信息。', 401, 'SESSION_REQUIRED');
    }

    const courses = await fetchTimetable({
      studentId,
      token,
      week: body.week,
      termId: String(body.termId ?? '').trim(),
    });
    return sendJson(res, 200, { courses });
  }

  return false;
}

async function serveStatic(req, res, pathname) {
  const requestedPath = pathname === '/' ? '/index.html' : pathname;
  const decoded = decodeURIComponent(requestedPath);
  const filePath = resolve(publicDir, `.${decoded}`);

  if (filePath !== publicDir && !filePath.startsWith(`${publicDir}${sep}`)) {
    return sendText(res, 403, 'Forbidden');
  }

  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw new Error('not a file');
    const content = await readFile(filePath);
    const contentType = mimeTypes[extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': content.length,
      'Cache-Control': filePath.endsWith('index.html') || filePath.endsWith('sw.js')
        ? 'no-cache'
        : 'public, max-age=3600',
    });
    res.end(content);
  } catch {
    sendText(res, 404, 'Not found');
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; " +
      "script-src 'self'; manifest-src 'self'; base-uri 'self'; form-action 'self'",
  );

  try {
    if (url.pathname.startsWith('/api/')) {
      const handled = await handleApi(req, res, url.pathname);
      if (handled === false) sendJson(res, 404, { error: '接口不存在。', code: 'NOT_FOUND' });
      return;
    }

    await serveStatic(req, res, url.pathname);
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 500;
    const code = error instanceof ApiError ? error.code : 'INTERNAL_ERROR';
    const message = error instanceof ApiError ? error.message : '服务器内部错误。';
    if (status >= 500) console.error(error);
    sendJson(res, status, { error: message, code });
  }
});

server.listen(port, '0.0.0.0', () => {
  console.log(`广金课表已启动：http://localhost:${port}`);
  console.log('手机访问时请使用电脑局域网 IP；公网部署必须启用 HTTPS。');
});
