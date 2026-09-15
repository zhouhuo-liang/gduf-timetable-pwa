const upstream = 'https://jwxt.gduf.edu.cn/app.do';

export class ApiError extends Error {
  constructor(message, status = 400, code = 'BAD_REQUEST') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function cleanText(value) {
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

export async function fetchTimetable({ studentId, token, week, termId }) {
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

export async function createSession(studentId, password, requestedWeek) {
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
