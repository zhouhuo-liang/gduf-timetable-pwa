import { ApiError, createSession } from '../lib/gduf.mjs';
import { readJsonBody, sendError, sendJson } from '../lib/http.mjs';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: '只支持 POST 请求。', code: 'METHOD_NOT_ALLOWED' });
  }

  try {
    const body = await readJsonBody(req);
    const studentId = String(body.studentId ?? '').trim();
    const password = String(body.password ?? '');
    if (!/^\d{6,20}$/.test(studentId)) throw new ApiError('请输入正确的学号。');
    if (!password) throw new ApiError('请输入教务系统密码。');

    const result = await createSession(studentId, password, body.week);
    return sendJson(res, 200, result);
  } catch (error) {
    return sendError(res, error);
  }
}
