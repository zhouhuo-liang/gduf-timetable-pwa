const STORAGE_KEY = 'gduf-timetable-cache-v1';
const TOKEN_KEY = 'gduf-timetable-token';
const STUDENT_KEY = 'gduf-timetable-student-id';
const WEEKDAY_NAMES = ['星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日'];
const PERIOD_TIMES = [
  '08:15\n09:00',
  '09:00\n09:45',
  '10:00\n10:45',
  '10:45\n11:30',
  '11:35\n12:20',
  '14:00\n14:45',
  '14:45\n15:30',
  '15:35\n16:20',
  '16:30\n17:15',
  '17:15\n18:00',
  '19:00\n19:45',
  '19:45\n20:30',
];

const elements = {
  loginPanel: document.querySelector('#loginPanel'),
  loadingPanel: document.querySelector('#loadingPanel'),
  schedulePanel: document.querySelector('#schedulePanel'),
  loginForm: document.querySelector('#loginForm'),
  studentId: document.querySelector('#studentId'),
  password: document.querySelector('#password'),
  loginButton: document.querySelector('#loginButton'),
  demoButton: document.querySelector('#demoButton'),
  refreshButton: document.querySelector('#refreshButton'),
  profileButton: document.querySelector('#profileButton'),
  previousWeek: document.querySelector('#previousWeek'),
  nextWeek: document.querySelector('#nextWeek'),
  weekPickerButton: document.querySelector('#weekPickerButton'),
  weekRange: document.querySelector('#weekRange'),
  weekTitle: document.querySelector('#weekTitle'),
  dayTitle: document.querySelector('#dayTitle'),
  termLabel: document.querySelector('#termLabel'),
  scheduleGrid: document.querySelector('#scheduleGrid'),
  scheduleScroll: document.querySelector('#scheduleScroll'),
  courseDialog: document.querySelector('#courseDialog'),
  courseDialogTitle: document.querySelector('#courseDialogTitle'),
  courseDetail: document.querySelector('#courseDetail'),
  weekDialog: document.querySelector('#weekDialog'),
  weekOptions: document.querySelector('#weekOptions'),
  profileDialog: document.querySelector('#profileDialog'),
  profileCard: document.querySelector('#profileCard'),
  reimportButton: document.querySelector('#reimportButton'),
  logoutButton: document.querySelector('#logoutButton'),
  toast: document.querySelector('#toast'),
  courseNav: document.querySelector('#courseNav'),
  todayNav: document.querySelector('#todayNav'),
  mineNav: document.querySelector('#mineNav'),
};

const state = {
  token: sessionStorage.getItem(TOKEN_KEY) || '',
  studentId: sessionStorage.getItem(STUDENT_KEY) || '',
  profile: null,
  current: null,
  selectedWeek: 1,
  courses: [],
  cache: new Map(),
  demo: false,
  busy: false,
};

let toastTimer;

function showToast(message, duration = 2600) {
  window.clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.add('is-visible');
  toastTimer = window.setTimeout(() => elements.toast.classList.remove('is-visible'), duration);
}

function setView(view) {
  elements.loginPanel.hidden = view !== 'login';
  elements.loadingPanel.hidden = view !== 'loading';
  elements.schedulePanel.hidden = view !== 'schedule';
}

function setBusy(busy) {
  state.busy = busy;
  elements.refreshButton.disabled = busy;
  elements.previousWeek.disabled = busy;
  elements.nextWeek.disabled = busy;
  elements.loginButton.disabled = busy;
}

function clearSession() {
  state.token = '';
  state.studentId = '';
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(STUDENT_KEY);
}

function readCache() {
  try {
    const cached = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (!cached || cached.version !== 1 || !Array.isArray(cached.courses)) return false;
    state.profile = cached.profile || null;
    state.current = cached.current || null;
    state.selectedWeek = clamp(Number(cached.selectedWeek) || state.current?.week || 1, 1, 40);
    state.courses = cached.courses;
    state.demo = Boolean(cached.demo);
    state.cache.set(state.selectedWeek, cached.courses);
    return true;
  } catch {
    return false;
  }
}

function writeCache() {
  const payload = {
    version: 1,
    profile: state.profile,
    current: state.current,
    selectedWeek: state.selectedWeek,
    courses: state.courses,
    demo: state.demo,
    savedAt: new Date().toISOString(),
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function parseLocalDate(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function addDays(date, amount) {
  const next = new Date(date);
  next.setDate(next.getDate() + amount);
  return next;
}

function mondayOf(date) {
  const copy = new Date(date);
  const weekday = (copy.getDay() + 6) % 7;
  copy.setHours(0, 0, 0, 0);
  copy.setDate(copy.getDate() - weekday);
  return copy;
}

function formatDay(date) {
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

function localDateYmd(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function currentWeekStart() {
  const serverStart = parseLocalDate(state.current?.startDate);
  const base = serverStart || mondayOf(new Date());
  const baseWeek = Number(state.current?.week) || 1;
  return addDays(base, (state.selectedWeek - baseWeek) * 7);
}

function currentDayIndex() {
  return (new Date().getDay() + 6) % 7;
}

function isSameDate(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }

  if (!response.ok) {
    const error = new Error(payload.error || `请求失败（HTTP ${response.status}）`);
    error.code = payload.code;
    error.status = response.status;
    throw error;
  }

  return payload;
}

function applySession(payload) {
  state.token = payload.token;
  state.studentId = payload.studentId;
  state.profile = payload.profile;
  state.current = payload.current;
  state.selectedWeek = clamp(Number(payload.week) || 1, 1, 40);
  state.courses = payload.courses || [];
  state.demo = false;
  state.cache.clear();
  state.cache.set(state.selectedWeek, state.courses);

  sessionStorage.setItem(TOKEN_KEY, state.token);
  sessionStorage.setItem(STUDENT_KEY, state.studentId);
  writeCache();
  setView('schedule');
  render();
}

async function handleLogin(event) {
  event.preventDefault();
  const studentId = elements.studentId.value.trim();
  const password = elements.password.value;
  if (!/^\d{6,20}$/.test(studentId)) {
    showToast('请输入正确的学号。');
    return;
  }
  if (!password) {
    showToast('请输入教务系统密码。');
    return;
  }

  setView('loading');
  setBusy(true);
  try {
    const payload = await requestJson('/api/session', {
      method: 'POST',
      body: JSON.stringify({ studentId, password }),
    });
    elements.password.value = '';
    applySession(payload);
    showToast(`已导入 ${payload.profile?.name || '你的'} 课程表`);
  } catch (error) {
    clearSession();
    setView('login');
    showToast(error.message, 4200);
  } finally {
    setBusy(false);
  }
}

async function loadWeek(week, force = false) {
  const target = clamp(Number(week) || 1, 1, 40);
  if (!state.token || !state.studentId || state.demo) {
    if (!state.demo) setView('login');
    return false;
  }
  if (!force && state.cache.has(target)) {
    state.selectedWeek = target;
    state.courses = state.cache.get(target);
    render();
    writeCache();
    return true;
  }

  setBusy(true);
  try {
    const payload = await requestJson('/api/timetable', {
      method: 'POST',
      body: JSON.stringify({
        studentId: state.studentId,
        token: state.token,
        week: target,
        termId: state.current?.termId || '',
      }),
    });
    state.selectedWeek = target;
    state.courses = payload.courses || [];
    state.cache.set(target, state.courses);
    writeCache();
    render();
    return true;
  } catch (error) {
    if (error.status === 401 || error.code === 'SESSION_EXPIRED') {
      clearSession();
      setView('login');
      showToast('登录状态已失效，请重新导入。', 4200);
    } else {
      showToast(error.message, 4200);
    }
    return false;
  } finally {
    setBusy(false);
  }
}

function createDayHeader(dayIndex, dates) {
  const node = document.createElement('div');
  node.className = 'day-head';
  const date = dates[dayIndex];
  if (date && isSameDate(date, new Date())) node.classList.add('is-today');

  const strong = document.createElement('strong');
  strong.textContent = WEEKDAY_NAMES[dayIndex].replace('星期', '周');
  const small = document.createElement('small');
  small.textContent = date ? formatDay(date) : '';
  node.append(strong, small);
  node.style.gridColumn = String(dayIndex + 2);
  return node;
}

function createPeriodCell(period) {
  const node = document.createElement('div');
  node.className = 'period-cell';
  node.style.gridRow = String(period + 1);

  const strong = document.createElement('strong');
  strong.textContent = String(period);
  const small = document.createElement('small');
  small.innerHTML = PERIOD_TIMES[period - 1].replace('\n', '<br>');
  node.append(strong, small);
  return node;
}

function createLine(className, style) {
  const line = document.createElement('div');
  line.className = className;
  Object.assign(line.style, style);
  return line;
}

function createCourseCard(course) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'course-card';
  card.dataset.color = String(Number(course.color) || 0);
  card.style.gridColumn = String(course.day + 1);
  card.style.gridRow = `${course.start + 1} / ${course.end + 2}`;
  card.title = `${course.name}，${course.room}`;

  const title = document.createElement('strong');
  title.textContent = course.name;
  const room = document.createElement('span');
  room.textContent = `@ ${course.room}`;
  const weeks = document.createElement('small');
  weeks.textContent = course.weeks;
  card.append(title, room, weeks);
  card.addEventListener('click', () => openCourseDialog(course));
  return card;
}

function render() {
  const week = state.selectedWeek;
  const date = new Date();
  const dayIndex = currentDayIndex();
  elements.weekTitle.textContent = `第 ${week} 周`;
  elements.dayTitle.textContent = WEEKDAY_NAMES[dayIndex];
  elements.termLabel.textContent = state.current?.termName
    ? `${state.profile?.college || '广东金融学院'} · ${state.current.termName}`
    : state.profile?.college || '广东金融学院';
  elements.weekRange.textContent = `${weekRangeText()} · 第 ${week} 周`;
  elements.scheduleGrid.replaceChildren();

  const corner = document.createElement('div');
  corner.className = 'grid-corner';
  elements.scheduleGrid.append(corner);

  const dates = Array.from({ length: 7 }, (_, index) => addDays(currentWeekStart(), index));
  for (let day = 0; day < 7; day += 1) {
    elements.scheduleGrid.append(createDayHeader(day, dates));
  }

  for (let period = 1; period <= 12; period += 1) {
    elements.scheduleGrid.append(createPeriodCell(period));
  }

  for (let day = 1; day <= 7; day += 1) {
    elements.scheduleGrid.append(createLine('grid-line', { gridColumn: String(day + 1) }));
  }

  for (let row = 3; row <= 13; row += 1) {
    elements.scheduleGrid.append(createLine('grid-row-line', { gridRow: String(row) }));
  }

  const courses = Array.isArray(state.courses) ? state.courses : [];
  if (!courses.length) {
    const empty = document.createElement('div');
    empty.className = 'course-card';
    empty.dataset.color = '1';
    empty.style.gridColumn = '2 / 9';
    empty.style.gridRow = '5 / 8';
    empty.style.display = 'grid';
    empty.style.alignContent = 'center';
    empty.style.textAlign = 'center';
    empty.innerHTML = '<strong>本周暂无课程</strong><span>可以切换周次或点击右上角重新导入</span>';
    elements.scheduleGrid.append(empty);
  } else {
    courses.forEach((course) => elements.scheduleGrid.append(createCourseCard(course)));
  }

  renderProfile();
  requestAnimationFrame(() => {
    if (week === state.current?.week && isSameDate(dates[dayIndex], new Date())) {
      const targetLeft = dayIndex * 108 + 54;
      elements.scheduleScroll.scrollTo({ left: Math.max(0, targetLeft - 70), behavior: 'smooth' });
    }
  });
}

function weekRangeText() {
  const monday = currentWeekStart();
  const sunday = addDays(monday, 6);
  return `${monday.getFullYear()}/${monday.getMonth() + 1}/${monday.getDate()} - ${sunday.getMonth() + 1}/${sunday.getDate()}`;
}

function createDetailRow(label, value) {
  const row = document.createElement('div');
  row.className = 'detail-row';
  const key = document.createElement('span');
  key.textContent = label;
  const content = document.createElement('span');
  content.textContent = value || '未提供';
  row.append(key, content);
  return row;
}

function openCourseDialog(course) {
  elements.courseDialogTitle.textContent = course.name;
  elements.courseDetail.replaceChildren(
    createDetailRow('时间', `${WEEKDAY_NAMES[course.day - 1]} 第 ${course.start}-${course.end} 节`),
    createDetailRow('周次', course.weeks),
    createDetailRow('教室', course.room),
    createDetailRow('教师', course.teacher),
    createDetailRow('作息', course.timeText || '以学校教务系统为准'),
  );
  elements.courseDialog.showModal();
}

function renderProfile() {
  const lastSaved = (() => {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null')?.savedAt;
    } catch {
      return '';
    }
  })();
  const savedText = lastSaved ? new Date(lastSaved).toLocaleString('zh-CN', { hour12: false }) : '尚未保存';

  elements.profileCard.replaceChildren(
    createDetailRow('姓名', state.profile?.name || '未登录'),
    createDetailRow('学号', state.studentId || '未登录'),
    createDetailRow('学院', state.profile?.college || '未提供'),
    createDetailRow('学期', state.current?.termName || '未提供'),
    createDetailRow('最近导入', savedText),
    state.demo ? createDetailRow('当前模式', '示例数据') : createDetailRow('数据位置', '仅保存在当前浏览器'),
  );
}

function renderWeekOptions() {
  elements.weekOptions.replaceChildren();
  for (let week = 1; week <= 30; week += 1) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'week-option';
    button.textContent = String(week);
    if (week === state.selectedWeek) button.classList.add('is-active');
    button.addEventListener('click', async () => {
      elements.weekDialog.close();
      await loadWeek(week);
    });
    elements.weekOptions.append(button);
  }
}

function createDemoSession() {
  const monday = mondayOf(new Date());
  const weekStart = addDays(monday, -7);
  const courses = [
    { day: 1, start: 3, end: 4, name: '马克思主义基本原理', teacher: '张老师', room: '北教 216', weeks: '1-16周', timeText: '10:00 - 11:30', color: 2 },
    { day: 2, start: 1, end: 2, name: '离散数学', teacher: '李老师', room: '南教 420', weeks: '1-16周', timeText: '08:15 - 09:45', color: 0 },
    { day: 2, start: 6, end: 7, name: '计算机组成原理', teacher: '陈老师', room: '南教 317', weeks: '1-16周 双周', timeText: '14:00 - 15:30', color: 6 },
    { day: 3, start: 1, end: 2, name: '数据结构', teacher: '王老师', room: '南教 420', weeks: '1-16周', timeText: '08:15 - 09:45', color: 0 },
    { day: 3, start: 6, end: 7, name: '概率论与数理统计 B', teacher: '周老师', room: '南教 417', weeks: '1-16周', timeText: '14:00 - 15:30', color: 1 },
    { day: 3, start: 9, end: 10, name: '数据结构', teacher: '王老师', room: '敏学楼 101', weeks: '1-16周', timeText: '16:30 - 18:00', color: 1 },
    { day: 4, start: 1, end: 2, name: '大学英语 III', teacher: '刘老师', room: '南教 316', weeks: '1-16周', timeText: '08:15 - 09:45', color: 3 },
    { day: 4, start: 3, end: 4, name: '数据库原理与应用', teacher: '赵老师', room: '敏学楼 101', weeks: '1-16周', timeText: '10:00 - 11:30', color: 5 },
    { day: 4, start: 6, end: 7, name: '形势与政策', teacher: '黄老师', room: '南教 215', weeks: '1-16周', timeText: '14:00 - 15:30', color: 0 },
    { day: 5, start: 1, end: 2, name: '走在前列的广东实践', teacher: '林老师', room: '南教 215', weeks: '1-16周', timeText: '08:15 - 09:45', color: 1 },
    { day: 5, start: 3, end: 4, name: 'Web 程序设计', teacher: '郑老师', room: '南教 417', weeks: '1-16周 双周', timeText: '10:00 - 11:30', color: 4 },
    { day: 5, start: 9, end: 10, name: 'Web 程序设计', teacher: '郑老师', room: '敏学楼 312', weeks: '1-16周 双周', timeText: '16:30 - 18:00', color: 4 },
    { day: 6, start: 11, end: 12, name: '程序设计综合实验', teacher: '吴老师', room: '敏学楼 215', weeks: '1-16周', timeText: '19:00 - 20:30', color: 4 },
  ].map((course, index) => ({ ...course, id: `demo-${index}` }));

  return {
    token: '',
    studentId: '0000000000',
    profile: { name: '示例同学', college: '示例学院', type: '学生' },
    current: {
      week: 2,
      termId: '2026-2027-1',
      termName: '2026-2027 学年第一学期',
      startDate: localDateYmd(weekStart),
      endDate: localDateYmd(addDays(weekStart, 6)),
      serverDate: localDateYmd(new Date()),
    },
    week: 2,
    courses,
  };
}

function loadDemo() {
  const payload = createDemoSession();
  state.token = '';
  state.studentId = payload.studentId;
  state.profile = payload.profile;
  state.current = payload.current;
  state.selectedWeek = payload.week;
  state.courses = payload.courses;
  state.demo = true;
  state.cache.clear();
  state.cache.set(state.selectedWeek, state.courses);
  clearSession();
  state.studentId = payload.studentId;
  state.demo = true;
  writeCache();
  setView('schedule');
  render();
  showToast('当前是示例课表，点击“我的 → 重新导入”登录真实账号。', 3600);
}

function bindEvents() {
  elements.loginForm.addEventListener('submit', handleLogin);
  elements.demoButton.addEventListener('click', loadDemo);
  elements.previousWeek.addEventListener('click', () => loadWeek(state.selectedWeek - 1));
  elements.nextWeek.addEventListener('click', () => loadWeek(state.selectedWeek + 1));
  elements.weekPickerButton.addEventListener('click', () => {
    if (state.demo) {
      showToast('示例模式不能切换真实周次。');
      return;
    }
    renderWeekOptions();
    elements.weekDialog.showModal();
  });
  elements.refreshButton.addEventListener('click', async () => {
    if (state.demo) {
      showToast('当前是示例课表。');
      return;
    }
    if (!state.token) {
      setView('login');
      return;
    }
    await loadWeek(state.selectedWeek, true);
  });
  elements.profileButton.addEventListener('click', () => {
    if (!state.profile) {
      setView('login');
      return;
    }
    renderProfile();
    elements.profileDialog.showModal();
  });
  elements.mineNav.addEventListener('click', () => {
    elements.mineNav.classList.add('is-active');
    elements.courseNav.classList.remove('is-active');
    elements.todayNav.classList.remove('is-active');
    if (state.profile) {
      renderProfile();
      elements.profileDialog.showModal();
    } else {
      setView('login');
    }
  });
  elements.courseNav.addEventListener('click', () => {
    elements.courseNav.classList.add('is-active');
    elements.todayNav.classList.remove('is-active');
    elements.mineNav.classList.remove('is-active');
    if (state.profile) setView('schedule');
  });
  elements.todayNav.addEventListener('click', async () => {
    elements.todayNav.classList.add('is-active');
    elements.courseNav.classList.remove('is-active');
    elements.mineNav.classList.remove('is-active');
    if (state.current?.week) await loadWeek(state.current.week);
    elements.scheduleScroll.scrollTo({ top: 0, behavior: 'smooth' });
  });
  elements.reimportButton.addEventListener('click', () => {
    elements.profileDialog.close();
    elements.studentId.value = state.studentId && /^\d+$/.test(state.studentId) ? state.studentId : '';
    elements.password.value = '';
    setView('login');
  });
  elements.logoutButton.addEventListener('click', () => {
    elements.profileDialog.close();
    clearSession();
    localStorage.removeItem(STORAGE_KEY);
    state.cache.clear();
    state.profile = null;
    state.current = null;
    state.courses = [];
    state.demo = false;
    setView('login');
    showToast('已清除本机保存的课表。');
  });
}

async function init() {
  bindEvents();
  if (new URLSearchParams(location.search).has('demo')) {
    loadDemo();
    return;
  }
  const hasCache = readCache();
  if (hasCache) {
    setView('schedule');
    render();
    if (state.token && !state.demo) {
      loadWeek(state.selectedWeek, false).catch(() => {});
    }
  } else {
    setView('login');
  }

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    });
  }
}

init();
