import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const publicDir = join(__dirname, 'public');
const port = Number(process.env.PORT || 4173);
const upstream = 'https://jwxt.gduf.edu.cn/app.do';
const maxBodyBytes = 64 * 1024;

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

class ApiError extends Error {
  constructor(message, status = 400, code = 'BAD_REQUEST') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

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

function cleanText(value) {
  return String(value ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractUpstreamMessage(text, status) {
  const title = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const message = title ? cleanText(title) : cleanText(text);
  if (message && !/^[\s<]*$/.test(message)) return message.slice(0, 180);
  return `学校接口请求失败（HTTP ${status}）。`;
}

async function callGduf(params, token = '') {
  const url = new URL(upstream);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }

  const headers = {
    Accept: 'application/json, text/plain, */*',
    'User-Agent': 'GDUF-Timetable-PWA/0.1',
  };
  if (token) headers.token = token;

  let response;
  try {
    response = await fetch(url, {
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    const detail = error?.name === 'TimeoutError' ? '学校接口响应超时。' : '无法连接学校教务系统。';
    throw new ApiError(detail, 502, 'UPSTREAM_UNREACHABLE');
  }

  const text = (await response.text()).replace(/^\uFEFF/, '').trim();
  if (!response.ok) {
    throw new ApiError(extractUpstreamMessage(text, response.status), 502, 'UPSTREAM_ERROR');
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(
      extractUpstreamMessage(text, response.status),
      502,
      'UPSTREAM_INVALID_RESPONSE',
    );
  }
}

function toInteger(value, fallback = 0) {
  const number = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function dateYmd(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function normalizeTimeCode(value) {
  const source = String(value ?? '');
  const compact = source.match(/\d+/g)?.join('') || '';

  if (compact.length >= 5) {
    return {
      day: clamp(toInteger(compact.slice(0, 1)), 1, 7),
      start: clamp(toInteger(compact.slice(1, 3)), 1, 20),
      end: clamp(toInteger(compact.slice(3, 5)), 1, 20),
    };
  }

  const range = source.match(/(\d+)\s*[-~至]\s*(\d+)/);
  if (range) {
    return {
      day: 0,
      start: clamp(toInteger(range[1]), 1, 20),
      end: clamp(toInteger(range[2]), 1, 20),
    };
  }

  return { day: 0, start: 0, end: 0 };
}

function adaptCourse(raw, index) {
  const time = normalizeTimeCode(raw?.kcsj ?? raw?.jcsj ?? raw?.section ?? '');
  const start = time.start;
  const end = Math.max(start, time.end || start);
  const name = cleanText(raw?.kcmc ?? raw?.courseName ?? raw?.name) || '未命名课程';
  const teacher = cleanText(raw?.jsxm ?? raw?.teacher ?? raw?.teacherName) || '教师待定';
  const room = cleanText(raw?.jsmc ?? raw?.room ?? raw?.classroom) || '地点待定';
  const weeks = cleanText(raw?.kkzc ?? raw?.weekText ?? raw?.weeks) || '周次待定';

  if (!time.day || !start) return null;

  return {
    id: `${time.day}-${start}-${end}-${name}-${room}-${index}`,
    day: time.day,
    start,
    end,
    name,
    teacher,
    room,
    weeks,
    timeText: [cleanText(raw?.kssj), cleanText(raw?.jssj)].filter(Boolean).join(' - '),
    color: (time.day + start + name.length) % 8,
  };
}

function normalizeCourses(payload) {
  const rows = Array.isArray(payload)
    ? payload
    : payload?.data ?? payload?.rows ?? payload?.list ?? [];

  if (!Array.isArray(rows)) return [];

  const seen = new Set();
  return rows
    .map(adaptCourse)
    .filter(Boolean)
    .filter((course) => {
      const key = `${course.day}-${course.start}-${course.end}-${course.name}-${course.room}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.day - b.day || a.start - b.start || a.name.localeCompare(b.name, 'zh-CN'));
}

async function fetchTimetable({ studentId, token, week, termId }) {
  const targetWeek = clamp(toInteger(week, 1), 1, 40);
  const params = {
    method: 'getKbcxAzc',
    xh: studentId,
    zc: targetWeek,
  };
  if (termId) params.xnxqid = termId;

  let payload;
  try {
    payload = await callGduf(params, token);
  } catch (error) {
    if (!termId) throw error;
    payload = await callGduf({ method: 'getKbcxAzc', xh: studentId, zc: targetWeek }, token);
  }

  if (payload && payload.token === -1) {
    throw new ApiError(cleanText(payload.msg) || '登录状态已失效。', 401, 'SESSION_EXPIRED');
  }

  return normalizeCourses(payload);
}

async function createSession(studentId, password, requestedWeek) {
  const auth = await callGduf({ method: 'authUser', xh: studentId, pwd: password });
  const token = String(auth?.token ?? '');
  if (!token || token === '-1') {
    throw new ApiError(cleanText(auth?.msg) || '学号或密码不正确。', 401, 'LOGIN_FAILED');
  }

  const current = await callGduf({ method: 'getCurrentTime', currDate: dateYmd(new Date()) }, token);
  const currentWeek = clamp(toInteger(current?.zc, 1), 1, 40);
  const week = clamp(toInteger(requestedWeek, currentWeek), 1, 40);
  const termId = cleanText(current?.xnxqh);
  const courses = await fetchTimetable({ studentId, token, week, termId });

  return {
    token,
    studentId,
    profile: {
      name: cleanText(auth?.userrealname) || `学号 ${studentId.slice(-4)}`,
      college: cleanText(auth?.userdwmc),
      type: cleanText(auth?.usertype),
    },
    current: {
      week: currentWeek,
      termId,
      termName: termId,
      startDate: cleanText(current?.s_time),
      endDate: cleanText(current?.e_time),
      serverDate: dateYmd(new Date()),
    },
    week,
    courses,
  };
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
