import { ApiError, fetchTimetable } from '../lib/gduf.mjs';
import { readJsonBody, sendError, sendJson } from '../lib/http.mjs';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: '只支持 POST 请求。', code: 'METHOD_NOT_ALLOWED' });
  }

  try {
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
  } catch (error) {
    return sendError(res, error);
  }
}
