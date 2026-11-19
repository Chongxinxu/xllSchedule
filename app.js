/* =====================================================================
   app.js · 课程管理系统 第一期
   ---------------------------------------------------------------------
   P0 全量 + 与 P0 共用架构的 P1 搭便车项
   数据分层：官方 scheduleEntries（只读/管理员写） / 用户私有 overrides、
   events、notes（本人读写）。前端渲染时把两层合并，个人修改永不污染官方数据。
   ===================================================================== */
(function () {
  'use strict';

  const CONFIG = {
    ALLOW_REGISTER: true,          // A01 开放注册，服务端规则禁止自封管理员
    ADMIN_EMAILS: [],              // 可选：管理员邮箱白名单（UI 判定，真权限在 firestore.rules）
    ADMIN_UIDS: [],
    BATCH_LIMIT: 400,
    SDK_TIMEOUT: 8000,
    FS_TIMEOUT: 14000
  };

  const firebaseConfig = {
    apiKey: "AIzaSyAQZJjTWFAoLYPMEcATH-rNVOu7Vwg1BpQ",
    authDomain: "xcxde-7d66f.firebaseapp.com",
    projectId: "xcxde-7d66f",
    storageBucket: "xcxde-7d66f.firebasestorage.app",
    messagingSenderId: "233866350706",
    appId: "1:233866350706:web:a832eedb4f96ddaca532eb"
  };

  const FIELDS = ['日期', '星期', '年级', '班号', '专业', 'КНР', '授课形式', '小组',
    '班级', '课程', '教师', '教室', '时间', '来源文件'];
  const WD_KEYS = { '周一': 1, '周二': 2, '周三': 3, '周四': 4, '周五': 5, '周六': 6, '周日': 7 };
  const WD_FROM_JS = { 0: 7, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6 };

  const FB = {};
  let auth = null, db = null, fbApp = null;

  function defaultProfile() {
    return {
      uid: '', email: '', name: '', role: 'student', lang: 'zh',
      faculty: '', program: '', group: '', teacher: '', defaultBy: 'group', filters: null
    };
  }

  function readStore(key, fallback) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
    catch (e) { return fallback; }
  }
  function writeStore(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* 无痕模式 */ }
  }

  const S = {
    lang: localStorage.getItem('cm.lang') || 'zh',
    view: window.innerWidth <= 760 ? 'day' : 'week',
    anchor: '',
    user: null,
    isAdmin: false,
    firebaseReady: false,
    cloudOK: false,
    profile: defaultProfile(),
    entries: [],
    overrides: {},
    events: [],
    notes: {},
    versions: [],
    uploads: [],
    logs: [],
    courseZh: {},
    dict: { faculties: [], programs: [], groups: [], teachers: [], modes: [], subgroups: [], weeks: [], courses: [] },
    filters: null,
    filtersPublic: null,
    pending: null,
    dateOverrides: {},
    conflictIds: new Set(),
    authMode: 'login',
    editCtx: null,
    detailId: null,
    adminMode: 'upload',
    space: 'public',                 // 左侧页签：public=公共课表 / mine=个人课表
    sidebarOpen: false,
    localMode: false,
    localAdmin: readStore('cm.localAdmin', false) === true
  };
  // 公共筛选器与个人课表完全分开：cm.filters 只保存公共筛选，游客/登录用户均可记忆
  function defaultFilters() {
    return {
      faculty: '', program: '', group: '', teacher: '', week: '', date: '',
      mode: '', subgroup: '', keyword: '', onlyMine: false
    };
  }
  function normalizePublicFilters(f) {
    const d = defaultFilters();
    if (!f || typeof f !== 'object') return d;
    return Object.assign(d, {
      faculty: f.faculty || '', group: f.group || '', teacher: f.teacher || '',
      week: f.week || '', subgroup: f.subgroup || '', keyword: f.keyword || ''
    });
  }
  function hasAnyFilter(f) {
    return !!(f && (f.faculty || f.group || f.teacher || f.week || f.subgroup || f.keyword));
  }
  function publicFilterClone() { return Object.assign({}, S.filtersPublic); }
  function mineFilterClone() { return Object.assign(defaultFilters(), { onlyMine: true }); }
  S.filtersPublic = normalizePublicFilters(readStore('cm.filters', {}));
  S.filters = Object.assign({}, S.filtersPublic);
  S.anchor = localToday();

  /* ------------------------------------------------------------ 基础工具 */
  const $ = id => document.getElementById(id);
  const T = (k, v) => I18N.t(k, S.lang, v);
  // 云端可用时靠真实管理员身份；云端不可用时只允许「本地管理模式」（显式开启，仅本机）
  const adminActive = () => S.cloudOK ? S.isAdmin : (S.localMode && S.localAdmin);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uniq = a => [...new Set(a.filter(Boolean))];
  function pad(n) { return String(n).padStart(2, '0'); }

  function localToday() {
    const d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function parseDay(s) {
    const p = String(s || localToday()).split('-').map(Number);
    return new Date(p[0], (p[1] || 1) - 1, p[2] || 1);
  }
  function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function addDays(s, n) { const d = parseDay(s); d.setDate(d.getDate() + n); return ymd(d); }
  function weekStart(s) { const d = parseDay(s); const off = (d.getDay() + 6) % 7; d.setDate(d.getDate() - off); return ymd(d); }
  function weekdayOf(s) { return WD_FROM_JS[parseDay(s).getDay()] || 7; }
  function weekLabel(s) {
    const d = parseDay(s), target = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const dayNum = target.getUTCDay() || 7;
    target.setUTCDate(target.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
    const n = Math.ceil((((target - yearStart) / 86400000) + 1) / 7);
    return T('view.weekOf', { n: n });
  }
  function timeRange(s) {
    const m = String(s || '').match(/(\d{1,2})[:.](\d{2})\s*[-–—]?\s*(\d{1,2})[:.](\d{2})/);
    if (!m) return [0, 0];
    const a = (+m[1]) * 60 + (+m[2]), b = (+m[3]) * 60 + (+m[4]);
    return [a, b > a ? b : a];
  }
  function timeStart(s) { return timeRange(s)[0]; }
  function hashId(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return 'k' + (h >>> 0).toString(36);
  }
  // ArrayBuffer <-> base64：把原始 Word 存进 Firestore，替代不可用的 Firebase Storage
  function bufToBase64(buf) {
    const bytes = new Uint8Array(buf);
    let bin = '';
    const step = 0x8000;
    for (let i = 0; i < bytes.length; i += step) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
    }
    return btoa(bin);
  }
  function base64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function nowIso() { return new Date().toISOString(); }
  function fmtIso(v) {
    if (!v) return '—';
    const d = new Date(v);
    return isNaN(d.getTime()) ? String(v) : ymd(d) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function toast(msg, type) {
    const box = $('toast'), el = document.createElement('div');
    el.className = 'toast-item' + (type ? ' ' + type : '');
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(() => el.remove(), 3600);
  }
  function setLoading(on, text) {
    $('loading').classList.toggle('open', !!on);
    if (text) $('loading-text').textContent = text;
  }
  function withTimeout(promise, ms, label) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(label + ' 超时')), ms);
      Promise.resolve(promise).then(v => { clearTimeout(timer); resolve(v); },
        e => { clearTimeout(timer); reject(e); });
    });
  }

  /* ------------------------------------------------------------ 条目模型 */
  // 教师名规范化：俄文姓名缩写「Р. М.」「Р.М.」是同一人，统一去掉缩写字母之间的空格。
  // 解析层（convert.py / docx.js）与此处保持一致；本函数兜底历史云端脏数据。
  function normTeacher(s) {
    if (!s) return s;
    return String(s).replace(/\s+/g, ' ').trim()
      .replace(/([А-ЯЁ])\.\s+([А-ЯЁ])\./g, '$1.$2.');
  }

  function normalizeEntry(raw, id) {
    const e = Object.assign({}, raw);
    e['教师'] = normTeacher(e['教师']);
    e.id = id || null;
    e._week = e._week || weekStart(e['日期'] || localToday());
    e._wd = WD_KEYS[e['星期']] || weekdayOf(e['日期']);
    e._start = timeStart(e['时间']);
    e._status = e._status || 'normal';
    e._active = e._active !== false;
    e._faculty = e._faculty || 'ВШУ МГУ';
    e['星期'] = e['星期'] || '周' + '一二三四五六日'[e._wd - 1];
    // 兼容云端/历史脏数据：КНР 只认班号 102。源文档曾把 (КНР) 误贴到 101 УП 抬头，
    // 会在筛选下拉里造出「1 курс гр. 101 УП (КНР)」这种不存在的班级。
    const clsNo = String(e['班号'] || '');
    if (clsNo && e['班级']) {
      if (clsNo === '102') {
        if (e['班级'].indexOf('(КНР)') < 0) e['班级'] = e['班级'].trim() + ' (КНР)';
        e['КНР'] = '是';
      } else if (e['班级'].indexOf('(КНР)') >= 0) {
        e['班级'] = e['班级'].replace(/\s*\(КНР\)/g, '').trim();
        e['КНР'] = '';
      }
    }
    return e;
  }
  // 内置常用课程中俄对照：中文界面默认显示中文名，管理员/本机自定义译名优先级更高
  const COURSE_ZH_BASE = {
    'python: введение в анализ данных': 'Python：数据分析导论',
    'английский язык брукс дуглас ли': '英语（布鲁克斯·道格拉斯·李）',
    'военная экономика': '军事经济学',
    'ии в бизнесе': '商业人工智能',
    'информационная безопасность и защита информации': '信息安全与信息保护',
    'информационно-аналитические технологии в управлении персоналом': '人力资源管理中的信息分析技术',
    'креативное и дизайн-мышление': '创意与设计思维',
    'криптоэкономика и технология блокчейн': '加密经济学与区块链技术',
    'логистика и управление цепями поставок': '物流与供应链管理',
    'моделирование и количественные методы анализа в бизнесе': '商业建模与定量分析方法',
    'моделирование и управление бизнес-процессами': '业务流程建模与管理',
    'обеспечение организации трудовыми ресурсами': '组织人力资源配置',
    'организационное поведение': '组织行为学',
    'правовая среда бизнеса и интеллектуальное право': '商业法律环境与知识产权',
    'прогнозирование развития технологий': '技术发展趋势预测',
    'продуктовая и прикладная аналитика': '产品与应用分析',
    'проектирование баз данных': '数据库设计',
    'русский как иностранный': '对外俄语',
    'системный анализ и теория принятия решений': '系统分析与决策理论',
    'системы искусственного интеллекта': '人工智能系统',
    'системы искусственного интеллекта и интеллектуальные вычисления': '人工智能系统与智能计算',
    'стратегический менеджмент': '战略管理',
    'теория организации и организационного проектирования': '组织理论与组织设计',
    'технологии обучения и развития персонала в цифровой экономике': '数字经济中的员工培训与发展技术',
    'технологии цифрового производства': '数字生产技术',
    'трудовое право и кадровый документооборот': '劳动法与人事档案管理',
    'управление бизнес-процессами': '业务流程管理',
    'управление изменениями и технологическая трансформация бизнеса': '变革管理与企业技术转型',
    'управление интеллектуальной собственностью': '知识产权管理',
    'управление персоналом высокотехнологичного предприятия': '高科技企业人力资源管理',
    'управление проектами': '项目管理',
    'управление рисками': '风险管理',
    'управление эффективностью труда': '劳动效率管理',
    'управленческая экономика': '管理经济学',
    'философия': '哲学',
    'финансовый анализ': '财务分析',
    'циркулярная экономика и "зеленые технологии"': '循环经济与“绿色技术”',
    'цифровой маркетинг': '数字营销',
    'нет занятий': '无课'
  };
  function courseKey(s) {
    return String(s || '')
      .replace(/\s*Группа\s+[АБ]\s*/gi, ' ')
      .replace(/\s*(Эконом\.?\s*фак\.?|Юр\.?\s*фак\.?|ауд\.?\s*уточняется|дист|Научный парк МГУ|очно|,543|a\.1ГУМ,?\s*П-9)\s*/gi, ' ')
      .replace(/[\s,]+/g, ' ')
      .trim()
      .toLowerCase();
  }
  function zhOf(e) {
    if (S.lang !== 'zh') return '';
    const raw = String(e['课程'] || '');
    return S.courseZh[raw] || e['课程中文'] || COURSE_ZH_BASE[courseKey(raw)] || '';
  }
  function modeLabel(v) {
    const key = 'mode.' + v;
    return I18N.PAIRS[key] ? T(key) : (v || T('common.empty'));
  }
  function statusLabel(v) { return T('state.' + (v || 'normal')); }

  // 「保存到个人课表」只是把课程收进我的课表（空 patch），不等于「个人修改」。
  // 只有真的覆盖了课程字段（课程名/时间/教师/教室等）才算修改过。
  function patchHasChanges(patch, base) {
    if (!patch || typeof patch !== 'object') return false;
    return Object.keys(patch).some(k =>
      String(patch[k] == null ? '' : patch[k]) !== String(base[k] == null ? '' : base[k]));
  }
  function noteTextOf(id) {
    const n = S.notes[id];
    const text = n && n.text ? String(n.text).trim() : '';
    return text;
  }
  // 个人视图：左侧「个人课程表」页签或勾选了「只看我的课表」
  function personalView() { return S.space === 'mine' || !!S.filters.onlyMine; }
  // 备注/覆盖只在个人视图生效；公共视图始终是官方数据，个人删除不会影响公共课表
  function isModified(e) { return !!(e._edited || e._noteText); }

  function mergedEntries() {
    const out = [];
    const mine = personalView();
    for (const e of S.entries) {
      if (!e._active) continue;
      const ov = S.overrides[e.id];
      const m = Object.assign({}, e);
      // 个人视图才应用覆盖；公共视图直接展示官方版本（含被个人隐藏的课程）
      if (mine && ov && ov.deleted) continue;
      if (mine && ov && ov.patch) Object.assign(m, ov.patch);
      m._zh = zhOf(m);
      m._saved = !!ov;                 // 仅用于「保存课表」去重，不控制显示
      m._personal = mine && !!ov && !ov.deleted;
      m._edited = mine && !!ov && !ov.deleted && patchHasChanges(ov.patch, e);
      m._noteText = mine ? noteTextOf(e.id) : '';
      m._officialUpdated = mine && !!(ov && e._publishedAt && ov.createdAt && ov.createdAt < e._publishedAt);
      m._start = timeStart(m['时间']);
      m._week = weekStart(m['日期']);
      m._wd = WD_KEYS[m['星期']] || weekdayOf(m['日期']);
      out.push(m);
    }
    if (mine) {
      for (const ev of S.events) {
        out.push(normalizeEntry({
          '日期': ev.date, '星期': '', '年级': '', '班号': '', '专业': '',
          'КНР': '', '授课形式': '', '小组': '全部', '班级': ev.group || '',
          '课程': ev.title, '教师': '', '教室': ev.room || '', '时间': ev.time,
          '来源文件': '', _event: true, _type: ev.type || 'personal',
          _status: 'normal', _personal: true, _zh: ''
        }, ev.id));
      }
    }
    return out;
  }

  function inScope(e) {
    const f = S.filters;
    const p = S.profile;
    // 个人范围一律以当前页签为准，不能依赖可能被筛选逻辑清掉的 onlyMine 字段
    if (personalView()) {
      // 个人日程与手动添加的事件永远属于「我的课表」
      if (e._event || e._personal) { /* 保留 */ }
      else {
        const key = personalKey();
        // 尚未设置班级/教师：个人页不展示任何官方课程，只显示个人日程
        if (!key) return false;
        if (p.defaultBy === 'teacher' ? e['教师'] !== key : e['班级'] !== key) return false;
      }
    }
    if (f.faculty && e._faculty !== f.faculty) return false;
    if (f.program && e['专业'] !== f.program) return false;
    if (f.group && e['班级'] !== f.group) return false;
    if (f.teacher && e['教师'] !== f.teacher) return false;
    if (f.mode && e['授课形式'] !== f.mode) return false;
    if (f.subgroup) {
      // 「Нет занятий」是占位行，不属于任何 A/B 组，分组筛选时应隐藏
      if (e['课程'] === 'Нет занятий') return false;
      if (e['小组'] !== f.subgroup && e['小组'] !== '全部') return false;
    }
    if (f.date && e['日期'] !== f.date) return false;
    if (f.week && e._week !== f.week) return false;
    const q = String(f.keyword || '').trim().toLowerCase();
    if (q) {
      const hay = [e['课程'], e._zh, e['教师'], e['班级'], e['教室'], e['授课形式']]
        .join(' ').toLowerCase();
      if (hay.indexOf(q) < 0) return false;
    }
    return true;
  }

  function computeConflicts(list) {
    S.conflictIds = new Set();
    // 时间冲突只在个人课表判断；公共课表不同班级同时上课是正常现象
    if (!personalView()) return;
    const byDay = {};
    list.forEach(e => {
      if (!e['时间'] || e._status === 'cancelled') return;
      (byDay[e['日期']] || (byDay[e['日期']] = [])).push(e);
    });
    Object.values(byDay).forEach(arr => {
      for (let i = 0; i < arr.length; i++) {
        const [a1, a2] = timeRange(arr[i]['时间']);
        for (let j = i + 1; j < arr.length; j++) {
          const [b1, b2] = timeRange(arr[j]['时间']);
          if (a1 < b2 && b1 < a2) {
            S.conflictIds.add(arr[i].id); S.conflictIds.add(arr[j].id);
          }
        }
      }
    });
  }

  /* ------------------------------------------------------------ 字典推导 */
  function buildDict() {
    const d = { faculties: [], programs: [], groups: [], teachers: [], modes: [], subgroups: [], weeks: [], courses: [] };
    for (const e of S.entries) {
      if (!e._active) continue;
      d.faculties.push(e._faculty);
      d.programs.push(e['专业']);
      d.groups.push(e['班级']);
      d.teachers.push(e['教师']);
      d.modes.push(e['授课形式']);
      d.subgroups.push(e['小组']);
      d.weeks.push(e._week);
      d.courses.push(e['课程']);
    }
    Object.keys(d).forEach(k => { d[k] = uniq(d[k]).sort(); });
    S.dict = d;
  }

  /* ------------------------------------------------------------ Firebase */
  async function initFirebase() {
    const base = 'https://www.gstatic.com/firebasejs/12.11.0/';
    try {
      const [appMod, authMod, fsMod] = await withTimeout(Promise.all([
        import(base + 'firebase-app.js'),
        import(base + 'firebase-auth.js'),
        import(base + 'firebase-firestore.js')
      ]), CONFIG.SDK_TIMEOUT, 'Firebase SDK');
      fbApp = appMod.initializeApp(firebaseConfig);
      Object.assign(FB, {
        getAuth: authMod.getAuth,
        createUserWithEmailAndPassword: authMod.createUserWithEmailAndPassword,
        signInWithEmailAndPassword: authMod.signInWithEmailAndPassword,
        signOut: authMod.signOut,
        onAuthStateChanged: authMod.onAuthStateChanged,
        sendPasswordResetEmail: authMod.sendPasswordResetEmail,
        getFirestore: fsMod.getFirestore,
        collection: fsMod.collection, doc: fsMod.doc,
        getDocs: fsMod.getDocs, getDoc: fsMod.getDoc,
        setDoc: fsMod.setDoc, updateDoc: fsMod.updateDoc, deleteDoc: fsMod.deleteDoc,
        addDoc: fsMod.addDoc, writeBatch: fsMod.writeBatch,
        query: fsMod.query, where: fsMod.where
      });
      auth = FB.getAuth(fbApp);
      db = FB.getFirestore(fbApp);
      S.firebaseReady = true;
      FB.onAuthStateChanged(auth, onAuthChanged);
    } catch (e) {
      console.warn('Firebase 不可用，降级为本地只读：', e);
      S.firebaseReady = false;
      fallbackLocal(T('admin.offline'));
    }
  }

  async function onAuthChanged(user) {
    S.user = user;
    if (!user) {
      S.profile = defaultProfile();
      S.profile.lang = S.lang;
      S.overrides = {}; S.events = []; S.notes = {};
      S.isAdmin = false;
      if (S.space === 'mine') { S.space = 'public'; S.filters = publicFilterClone(); updateSpaceTabs(); }
      updateChrome(); render();
      return;
    }
    S.profile.uid = user.uid;
    S.profile.email = user.email || '';
    await loadUserData();
    await resolveAdmin(user);
    updateChrome(); updateSpaceTabs(); render();
  }

  async function resolveAdmin(user) {
    let ok = CONFIG.ADMIN_EMAILS.indexOf(user.email) >= 0 || CONFIG.ADMIN_UIDS.indexOf(user.uid) >= 0;
    if (!ok && S.cloudOK && S.firebaseReady) {
      try {
        const snap = await FB.getDoc(FB.doc(db, 'admins', user.uid));
        ok = snap.exists();
      } catch (e) { /* 规则拒绝时按非管理员处理 */ }
    }
    S.isAdmin = ok;
    if (!ok && user.email && /@schedule\.local$/.test(user.email) && !window.__adminHintShown) {
      window.__adminHintShown = true;
      toast(T('auth.adminSetup'));
    }
  }

  /* ------------------------------------------------------------ 云端读取 */
  async function loadCloud() {
    if (!S.firebaseReady) { fallbackLocal(T('admin.offline')); return; }
    // 不用全屏遮罩：首屏本地 data.js 已经渲染好，云端慢时不能把内容盖住
    $('meta-publish').textContent = T('common.cloudLoading');
    try {
      const col = n => FB.collection(db, n);
      const [entSnap, verSnap, upSnap, logSnap, dictSnap] = await withTimeout(Promise.all([
        FB.getDocs(col('scheduleEntries')),
        FB.getDocs(col('scheduleVersions')),
        FB.getDocs(col('uploadedFiles')),
        FB.getDocs(col('changeLogs')),
        FB.getDocs(col('courseDict'))
      ]), CONFIG.FS_TIMEOUT, '云端读取');

      let entries = entSnap.docs.map(d => normalizeEntry(d.data(), d.id));
      // 本地 data.js（convert.py 从全部 Word 生成）既作兜底，也作补齐来源。
      // 坑：scheduleEntries 常常只发布了部分教学周，若直接拿它整体覆盖，
      // 未发布的周会「消失」；旧 courses 集合更陈旧（曾只到 11-14），更不能整体覆盖较新的本地数据。
      // 合并策略：云端已出现的日期以云端为准（管理员发布/改过的版本，含 _active:false 的下线记录），
      // 云端完全没有的日期用本地 data.js 补齐，保证最新一周不会因云端尚未发布而丢失。
      const localRows = (typeof scheduleData !== 'undefined' && Array.isArray(scheduleData)) ? scheduleData : [];
      const localEntries = localRows.map((r, i) => normalizeEntry(r, 'local-' + i));
      if (!entries.length && !localEntries.length) {
        const oldSnap = await FB.getDocs(col('courses'));
        entries = oldSnap.docs.map(d => normalizeEntry(d.data(), d.id));
        if (entries.length) toast(T('admin.legacyDetected'));
      } else if (entries.length && localEntries.length) {
        const cloudDates = new Set(entries.map(e => e['日期']));
        const missing = localEntries.filter(e => !cloudDates.has(e['日期']));
        if (missing.length) entries = entries.concat(missing);
      } else if (!entries.length) {
        entries = localEntries;
      }
      S.versions = verSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      S.uploads = upSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      S.logs = logSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      S.courseZh = {};
      dictSnap.docs.forEach(d => { const x = d.data(); if (x && x.ru) S.courseZh[x.ru] = x.zh || ''; });

      if (!entries.length) { fallbackLocal(T('view.noCourses')); return; }
      S.entries = entries;
      S.cloudOK = true;
      S.localMode = false;
      showOffline(false);
      buildDict();
      await loadUserData();
      await resolveAdmin(S.user);
      initFilterOptions();
      S.anchor = snapToDataDate(S.anchor);
      updateChrome(); render();
    } catch (e) {
      console.error('云端读取失败：', e);
      fallbackLocal(T('admin.offline'));
    }
  }

  function fallbackLocal(reason) {
    loadLocalData(true, reason);
  }

  function loadLocalData(showBanner, reason) {
    const rows = (typeof scheduleData !== 'undefined' && Array.isArray(scheduleData)) ? scheduleData : [];
    S.entries = rows.map((r, i) => normalizeEntry(r, 'local-' + i));
    S.cloudOK = false;
    S.localMode = true;
    S.courseZh = Object.assign({}, readStore('cm.localZh', {}));
    buildDict();
    initFilterOptions();
    S.anchor = snapToDataDate(S.anchor);
    showOffline(!!showBanner, reason);
    updateChrome(); render();
  }

  // 离线横幅默认永久隐藏：国内网络下 Firebase 常不可达，横幅会一直占位置。
  // 本地管理仍可通过 URL ?localAdmin=1 开启、?localAdmin=0 关闭，状态存 localStorage。
  function showOffline(on, reason) {
    const b = $('offline-banner');
    if (b) b.classList.add('hidden');
    const btn = $('btn-local-admin'), txt = $('offline-text');
    if (btn) {
      btn.textContent = S.localAdmin ? T('offline.localAdminOff') : T('offline.localAdminBtn');
      btn.classList.add('hidden');
    }
    if (txt && on) {
      txt.textContent = (on && S.localAdmin) ? T('offline.localAdminOn') : (reason || T('admin.offline'));
    }
  }

  async function loadUserData() {
    const u = S.user;
    if (!u || !S.firebaseReady || !S.cloudOK) return;
    const localPublic = S.filtersPublic;
    try {
      const col = n => FB.collection(db, n);
      const q = n => FB.query(col(n), FB.where('uid', '==', u.uid));
      const [profileSnap, ovSnap, evSnap, noteSnap] = await withTimeout(Promise.all([
        FB.getDoc(FB.doc(db, 'users', u.uid)),
        FB.getDocs(q('userScheduleOverrides')),
        FB.getDocs(q('userEvents')),
        FB.getDocs(q('userNotes'))
      ]), CONFIG.FS_TIMEOUT, '个人数据读取');

      if (profileSnap.exists()) S.profile = Object.assign(defaultProfile(), profileSnap.data(), { uid: u.uid, email: u.email });
      else S.profile = Object.assign(defaultProfile(), { uid: u.uid, email: u.email, lang: S.lang });
      if (S.profile.lang && S.profile.lang !== S.lang) { S.lang = S.profile.lang; applyI18n(); }
      // 公共筛选：本机有记录优先恢复本机；否则用账号云端记录。两者都只存公共条件。
      S.filtersPublic = hasAnyFilter(localPublic)
        ? localPublic
        : normalizePublicFilters(S.profile.filters || {});
      writeStore('cm.filters', S.filtersPublic);
      if (S.space === 'public') S.filters = publicFilterClone();

      S.overrides = {};
      ovSnap.docs.forEach(d => { const x = d.data(); S.overrides[x.entryId] = { id: d.id, ...x }; });
      S.events = evSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      S.notes = {};
      noteSnap.docs.forEach(d => { const x = d.data(); S.notes[x.entryId] = { id: d.id, ...x }; });
    } catch (e) { console.warn('个人数据读取失败：', e); }
  }

  /* ------------------------------------------------------------ 批量写 */
  async function chunkedBatch(items, makeOp) {
    for (let i = 0; i < items.length; i += CONFIG.BATCH_LIMIT) {
      const batch = FB.writeBatch(db);
      items.slice(i, i + CONFIG.BATCH_LIMIT).forEach(item => makeOp(batch, item));
      await batch.commit();
    }
  }
  async function writeLog(action, target, detail) {
    if (!S.cloudOK || !S.isAdmin) return;
    try {
      await FB.addDoc(FB.collection(db, 'changeLogs'), {
        uid: S.user ? S.user.uid : '', at: nowIso(), action: action, target: target, detail: detail || ''
      });
      S.logs.push({ at: nowIso(), action: action, target: target, detail: detail || '' });
    } catch (e) { console.warn('修改记录写入失败：', e); }
  }

  /* ------------------------------------------------------------ 界面文案 */
  const LABELS = {
    'app-title': 'app.title', 'app-tagline': 'app.tagline',
    'side-brand-1': 'brand.name', 'side-brand-2': 'brand.sub',
    'nav-public-label': 'space.public', 'nav-mine-label': 'space.mine',
    'nav-help-label': 'space.help', 'nav-account-label': 'space.account',
    'page-title': 'page.schedule', 'page-sub': 'page.sub', 'info-note-text': 'page.info',
    'tab-week': 'nav.week', 'tab-day': 'nav.day', 'tab-list': 'nav.list',
    'btn-login': 'nav.login', 'btn-profile': 'nav.profile', 'btn-logout': 'nav.logout',
    'lb-faculty': 'filter.faculty', 'lb-group': 'filter.group',
    'lb-teacher': 'filter.teacher', 'lb-week': 'filter.week',
    'lb-subgroup': 'filter.subgroup', 'lb-onlymine': 'filter.onlyMine',
    'btn-reset': 'common.reset', 'btn-save-filters': 'filter.save',
    'btn-save-schedule': 'filter.saveSchedule', 'btn-restore': 'filter.restore',
    'detail-title': 'detail.title', 'restore-title': 'restore.title',
    'btn-export': 'common.export',
    'admin-label': 'nav.admin', 'btn-upload': 'nav.upload', 'btn-courses': 'nav.courses',
    'btn-translations': 'nav.translations', 'btn-uploads': 'nav.uploads',
    'btn-changelog': 'nav.changelog', 'btn-migrate': 'nav.migrate',
    'auth-title': 'auth.loginTitle', 'lb-auth-email': 'auth.email', 'lb-auth-password': 'auth.password',
    'lb-auth-name': 'auth.name',
    'auth-toggle': 'auth.toRegister', 'auth-forgot': 'auth.forgot', 'auth-close': 'common.close',
    'auth-hint': 'auth.hint',
    'profile-title': 'profile.title', 'lb-p-name': 'profile.name', 'lb-p-faculty': 'profile.faculty',
    'lb-p-program': 'profile.program', 'lb-p-group': 'profile.group', 'lb-p-teacher': 'profile.teacher',
    'lb-p-defaultby': 'profile.defaultBy', 'lb-p-lang': 'profile.lang',
    'p-save': 'common.save', 'p-close': 'common.cancel', 'p-hint': 'profile.loginHint',
    'detail-title': 'detail.title', 'detail-close': 'common.close',
    'edit-title': 'edit.titleEdit', 'lb-e-course': 'edit.course', 'lb-e-date': 'detail.date',
    'lb-e-time': 'detail.time', 'lb-e-teacher': 'detail.teacher', 'lb-e-room': 'detail.room',
    'lb-e-mode': 'detail.mode', 'lb-e-group': 'detail.group', 'lb-e-subgroup': 'detail.subgroup',
    'lb-e-status': 'detail.status', 'lb-e-type': 'detail.eventType',
    'e-save': 'common.save', 'e-close': 'common.cancel',
    'admin-title': 'nav.admin', 'admin-close': 'common.close'
  };

  function applyI18n() {
    Object.keys(LABELS).forEach(id => { const el = $(id); if (el) el.textContent = T(LABELS[id]); });
    $('f-keyword').placeholder = T('filter.keyword');
    $('auth-submit').textContent = S.authMode === 'register' ? T('auth.doRegister') : T('auth.doLogin');
    const opts = [
      ['p-defaultby', [['group', 'profile.byGroup'], ['teacher', 'profile.byTeacher']]],
      ['e-status', [['normal', 'state.normal'], ['cancelled', 'state.cancelled'], ['rescheduled', 'state.rescheduled']]],
      ['e-type', [['personal', 'detail.eventOther'], ['exam', 'detail.eventExam'], ['homework', 'detail.eventHomework']]]
    ];
    opts.forEach(([id, list]) => {
      const el = $(id); if (!el) return;
      const cur = el.value;
      el.innerHTML = list.map(([v, k]) => '<option value="' + v + '">' + esc(T(k)) + '</option>').join('');
      el.value = cur;
    });
    $('lang-zh').classList.toggle('active', S.lang === 'zh');
    $('lang-ru').classList.toggle('active', S.lang === 'ru');
    document.documentElement.lang = S.lang === 'ru' ? 'ru' : 'zh';
    document.title = T('app.title');
    $('btn-prev').textContent = T('view.prevWeek');
    $('btn-next').textContent = T('view.nextWeek');
    // 无文字的图标按钮靠 title 提供无障碍提示
    const titles = { 'side-toggle': 'nav.public', 'btn-prev': 'view.prevWeek', 'btn-next': 'view.nextWeek', 'view-date': 'view.pickDate' };
    Object.keys(titles).forEach(id => { const el = $(id); if (el) el.title = T(titles[id]); });
    const lt = $('loading-text'); if (lt && !$('loading').classList.contains('open')) lt.textContent = T('common.loading');
    updateSpaceTabs();
    initFilterOptions();
  }

  // 个人课表的筛选依据：班级或教师（二选一，取决于 defaultBy）
  function personalKey() {
    const p = S.profile;
    return (p.defaultBy === 'teacher' ? p.teacher : p.group) || '';
  }

  // 左侧「公共 / 个人」页签高亮：mine 与 onlyMine 同步
  function updateSpaceTabs() {
    document.querySelectorAll('.side-item[data-space]').forEach(btn =>
      btn.classList.toggle('active', btn.dataset.space === S.space));
    const mine = S.space === 'mine';
    // 个人课表隐藏全部筛选控件；公共筛选条件仍保留在 S.filtersPublic 中
    document.querySelectorAll('.public-only').forEach(el => el.classList.toggle('hidden', mine));
    const cb = $('f-onlymine'); if (cb) cb.checked = mine;
    // 「恢复已删课程」属于个人课表操作，公共视图不显示
    const restoreBtn = $('btn-restore');
    if (restoreBtn) restoreBtn.classList.toggle('hidden', !mine || !S.user);
    const note = $('info-note-text');
    if (note) note.textContent = T(!mine ? 'page.info'
      : (!S.user ? 'detail.needLogin'
        : (personalKey() ? 'page.mine' : 'page.mineSetup')));
  }

  function setSpace(space) {
    // 未登录才要求登录；已登录即使还没设置班级/教师，也直接切到个人页签。
    if (space === 'mine' && !S.user) { needLogin(); return; }
    // 离开公共视图前保存公共筛选，回来时原样恢复；个人视图使用独立空筛选。
    if (S.space === 'public' && space === 'mine') S.filtersPublic = normalizePublicFilters(S.filters);
    S.space = space;
    S.filters = space === 'mine' ? mineFilterClone() : publicFilterClone();
    writeStore('cm.filters', S.filtersPublic);
    updateSpaceTabs();
    initFilterOptions();
    render();
    closeSidebar();
  }

  function openSidebar() { S.sidebarOpen = true; $('sidebar').classList.add('open'); }
  function closeSidebar() { S.sidebarOpen = false; $('sidebar').classList.remove('open'); }

  function switchLang(lang) {
    S.lang = lang;
    localStorage.setItem('cm.lang', lang);
    S.profile.lang = lang;
    if (S.user && S.cloudOK) {
      FB.updateDoc(FB.doc(db, 'users', S.user.uid), { lang: lang }).catch(() => {});
    }
    applyI18n(); render();
  }

  /* ------------------------------------------------------------ 顶栏 / 状态 */
  function updateChrome() {
    const b = $('perm-badge'), admin = adminActive();
    b.className = 'badge' + (admin ? ' admin' : (S.user ? ' user' : ''));
    b.textContent = admin ? (S.localMode ? T('offline.localAdminBadge') : T('nav.adminBadge'))
      : (S.user ? T('nav.user') : T('nav.guest'));
    $('user-label').textContent = S.user ? (S.profile.name || S.user.email || '') : '';
    $('btn-login').classList.toggle('hidden', !!S.user);
    // 「个人设置」入口按需求屏蔽，永久隐藏（底层函数保留，不影响其他调用）
    $('btn-profile').classList.add('hidden');
    $('btn-logout').classList.toggle('hidden', !S.user);
    $('admin-bar').classList.toggle('hidden', !admin);
    $('f-onlymine').disabled = !S.user;
    $('meta-mode').textContent = S.cloudOK ? (S.isAdmin ? T('nav.adminBadge') : T('common.official'))
      : (S.localAdmin ? T('offline.localAdminBadge') : T('admin.offline').split('，')[0]);
    const last = S.versions.slice().sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)))[0];
    $('meta-publish').textContent = last ? T('view.lastPublish', { v: fmtIso(last.publishedAt) }) : T('view.neverPublish');
    $('meta-count').textContent = T('view.count', { n: S.entries.filter(e => e._active).length });
    $('meta-week').textContent = weekLabel(S.anchor);
    document.querySelectorAll('#view-tabs button').forEach(btn =>
      btn.classList.toggle('active', btn.dataset.view === S.view));
  }

  /* ------------------------------------------------------------ 筛选器 */
  function fillSelect(id, values, formatter, key, src) {
    const el = $(id);
    // 不能用 `src[key] || el.value`：清空筛选时 '' 会回落到旧值，导致「清除筛选」无效
    const source = src || S.filters;
    const cur = key ? source[key] : el.value;
    const all = T('common.all');
    const opts = ['<option value="">' + esc(all) + '</option>'].concat(
      values.map(v => '<option value="' + esc(v) + '">' + esc(formatter ? formatter(v) : v) + '</option>'));
    el.innerHTML = opts.join('');
    el.value = values.indexOf(cur) >= 0 ? cur : '';
    return el.value;
  }

  function initFilterOptions() {
    const d = S.dict, src = S.filtersPublic;
    fillSelect('f-faculty', d.faculties || [], null, 'faculty', src);
    fillSelect('f-group', d.groups || [], null, 'group', src);
    fillSelect('f-teacher', d.teachers || [], null, 'teacher', src);
    fillSelect('f-subgroup', (d.subgroups || []).filter(v => v !== '全部'), null, 'subgroup', src);
    fillSelect('f-week', d.weeks || [], v => weekLabel(v) + ' · ' + v, 'week', src);
    // 已移除的筛选项强制清空，避免历史保存值在后台继续生效
    src.program = ''; src.mode = ''; src.date = '';
    $('f-keyword').value = src.keyword || '';
    $('f-onlymine').checked = S.space === 'mine';
    // 锁死当前视图的筛选来源：个人视图永远用专属空筛选，不继承任何公共条件
    S.filters = S.space === 'mine' ? mineFilterClone() : publicFilterClone();
  }

  let filterSyncTimer = null;
  function collectFilters() {
    // 个人课表隐藏筛选器，任何残留事件都不能把个人筛选状态改回公共筛选
    if (S.space === 'mine') return;
    // 只收集公共筛选器；个人课表不使用这些条件
    S.filtersPublic = normalizePublicFilters({
      faculty: $('f-faculty').value,
      group: $('f-group').value, teacher: $('f-teacher').value,
      week: $('f-week').value,
      subgroup: $('f-subgroup').value,
      keyword: $('f-keyword').value.trim()
    });
    S.filters = publicFilterClone();
    // 每次变动即存本地，游客也能在同设备恢复；登录用户再静默同步云端
    writeStore('cm.filters', S.filtersPublic);
    if (S.user && S.cloudOK) {
      clearTimeout(filterSyncTimer);
      filterSyncTimer = setTimeout(() => {
        FB.updateDoc(FB.doc(db, 'users', S.user.uid), { filters: S.filtersPublic }).catch(() => {});
      }, 600);
    }
  }

  function saveFilters() {
    collectFilters();
    toast(T('filter.saved'), 'ok');
  }

  /* ------------------------------------------------------------ 视图渲染 */
  function rangeEntries() {
    const all = mergedEntries().filter(inScope);
    if (S.view === 'week') return all.filter(e => e._week === weekStart(S.anchor));
    if (S.view === 'day') return all.filter(e => e['日期'] === S.anchor);
    return all;
  }

  // 导航只在「有数据的日期/周」之间移动：官方数据 + 个人视图里的个人日程/改期
  function dataDates() {
    const dates = S.entries.filter(e => e._active !== false).map(e => e['日期']);
    if (personalView()) {
      S.events.forEach(ev => dates.push(ev.date));
      Object.values(S.overrides).forEach(o => {
        if (o.deleted) return;
        const base = S.entries.find(e => e.id === o.entryId);
        dates.push((o.patch && o.patch['日期']) || (base && base['日期']));
      });
    }
    return uniq(dates).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  }
  function dataWeeks() { return uniq(dataDates().map(weekStart)).sort(); }
  // 日期选择器落到空日期时，吸附到最近的有数据日期
  function snapToDataDate(s) {
    const dates = dataDates();
    if (!dates.length || dates.indexOf(s) >= 0) return s;
    return dates.find(d => d > s) || dates[dates.length - 1];
  }
  // 上一周/下一周与日期跳转都属于时间导航，清除教学周筛选，避免筛选把导航结果挡掉
  function clearWeekFilter() {
    if (!S.filtersPublic.week) return;
    S.filtersPublic.week = '';
    if (S.space === 'public') S.filters.week = '';
    writeStore('cm.filters', S.filtersPublic);
    const sel = $('f-week'); if (sel) sel.value = '';
  }

  function tagHtml(text, cls) { return '<span class="tag ' + (cls || '') + '">' + esc(text) + '</span>'; }
  // Word 原文里小组标记常混在课程名中，展示时去掉（数据本身保持不变，与 convert.py 一致）
  function displayCourse(e) {
    return String(e['课程'] || '').replace(/\s*Группа\s+[АБ]\s*/gi, ' ').replace(/\s+/g, ' ').trim();
  }

  function cardHtml(e, compact) {
    if (e['课程'] === 'Нет занятий' && !e._saved) {
      return '<div class="no-class" data-id="' + esc(e.id) + '">' + esc(T('card.noClass')) + '</div>';
    }
    const cls = ['card'];
    // 仅真正改过（或有备注）的课程用黄色强调；单纯「保存课表」保持官方样式
    if (e._saved && !e._event && isModified(e)) cls.push('personal');
    if (e._event) cls.push('event');
    if (e._status === 'cancelled') cls.push('cancelled');
    if (S.conflictIds.has(e.id)) cls.push('conflict');
    if (S.notes[e.id] && S.notes[e.id].star) cls.push('starred');
    const tags = [];
    if (e['教室'] === '网课') tags.push(tagHtml(T('common.online'), 'blue'));
    if (isModified(e)) tags.push(tagHtml(T('common.personal'), 'yellow'));
    if (e._officialUpdated) tags.push(tagHtml(T('common.updated'), 'red'));
    if (e._status && e._status !== 'normal') tags.push(tagHtml(statusLabel(e._status), 'red'));
    if (S.conflictIds.has(e.id)) tags.push(tagHtml(T('view.conflict'), 'red'));
    if (e._event && e._type !== 'personal') {
      const k = e._type === 'exam' ? 'detail.eventExam' : 'detail.eventHomework';
      tags.push(tagHtml(T(k), 'purple'));
    }
    if (e['小组'] && e['小组'] !== '全部') tags.push(tagHtml(e['小组'], ''));
    if (S.notes[e.id] && S.notes[e.id].star) tags.push('<span class="tag star-tag">★</span>');
    const zh = e._zh && e._zh !== e['课程'] ? '<span class="zh"> · ' + esc(e._zh) + '</span>' : '';
    const line = [e['教师'], e['教室'] === '网课' ? '' : e['教室'], modeLabel(e['授课形式'])]
      .filter(Boolean).join(' · ');
    let html = '<div class="' + cls.join(' ') + '" data-id="' + esc(e.id) + '">' +
      '<div class="time">' + esc(e['时间'] || '—') + '</div>' +
      '<div class="name">' + esc(displayCourse(e)) + zh + '</div>' +
      (compact ? '' : '<div class="line">' + esc(line || e['班级'] || '') + '</div>') +
      (tags.length ? '<div class="tags">' + tags.join('') + '</div>' : '');
    // 备注只在个人课程表里展示，直接贴在课程卡片上（与截图位置一致）
    if (personalView() && e._noteText) {
      html += '<div class="card-note" title="' + esc(e._noteText) + '"><b>' + esc(T('card.note')) + '</b>' +
        esc(e._noteText) + '</div>';
    }
    return html + '</div>';
  }

  function emptyHtml(msg) {
    return '<div class="empty-state"><strong>' + esc(msg) + '</strong>' +
      esc(T('view.noMatch')) + '</div>';
  }

  function renderWeek(list) {
    const start = weekStart(S.anchor);
    let html = '<div class="week-grid">';
    for (let i = 0; i < 7; i++) {
      const day = addDays(start, i), wd = weekdayOf(day);
      const rows = list.filter(e => e['日期'] === day).sort((a, b) => a._start - b._start);
      html += '<div class="day-col' + (day === localToday() ? ' today' : '') + '">' +
        '<h3>' + esc(T('wd.' + wd)) + '<span>' + esc(day.slice(5)) + '</span></h3>' +
        (rows.length ? rows.map(e => cardHtml(e)).join('') : '<div class="line" style="color:var(--muted)">—</div>') +
        '</div>';
    }
    return html + '</div>';
  }

  function renderDay(list) {
    const rows = list.filter(e => e['日期'] === S.anchor).sort((a, b) => a._start - b._start);
    if (!rows.length) return emptyHtml(T('view.noCourses'));
    return '<div class="day-list">' + rows.map(e =>
      '<div class="row-card"><div class="row-time">' + esc(e['时间'] || '—') + '</div>' +
      cardHtml(e) + '</div>').join('') + '</div>';
  }

  function renderList(list) {
    const rows = list.slice().sort((a, b) =>
      String(a['日期']).localeCompare(String(b['日期'])) || a._start - b._start);
    if (!rows.length) return emptyHtml(T('view.noMatch'));
    const head = ['detail.date', 'detail.weekday', 'detail.time', 'detail.group', 'detail.nameRu',
      'detail.teacher', 'detail.room', 'detail.mode', 'detail.status'];
    let html = '<div class="table-scroll"><table class="grid-table"><thead><tr>' +
      head.map(k => '<th>' + esc(T(k)) + '</th>').join('') +
      '<th>' + esc(T('common.personal')) + '</th><th></th></tr></thead><tbody>';
    rows.forEach(e => {
      const past = e['日期'] < localToday();
      html += '<tr data-id="' + esc(e.id) + '" class="' + (past ? 'past' : '') + '">' +
        '<td>' + esc(e['日期']) + '</td><td>' + esc(T('wd.' + e._wd)) + '</td>' +
        '<td>' + esc(e['时间']) + '</td><td>' + esc(e['班级']) + '</td>' +
        '<td><strong>' + esc(displayCourse(e)) + '</strong>' + (e._zh ? '<div class="line">' + esc(e._zh) + '</div>' : '') + '</td>' +
        '<td>' + esc(e['教师']) + '</td><td>' + esc(e['教室']) + '</td>' +
        '<td>' + esc(modeLabel(e['授课形式'])) + '</td><td>' + esc(statusLabel(e._status)) + '</td>' +
        '<td>' + (e._event ? tagHtml(T('common.personalEvent'), 'purple')
          : (isModified(e) ? tagHtml(T('common.personal'), 'yellow') : '')) +
        (e._officialUpdated ? tagHtml(T('common.updated'), 'red') : '') + '</td>' +
        '<td>' + (S.isAdmin && S.cloudOK && !e._event
          ? '<button class="link-btn" data-act="edit" data-id="' + esc(e.id) + '">' + esc(T('common.edit')) + '</button>' +
            '<button class="link-btn danger" data-act="del" data-id="' + esc(e.id) + '">' + esc(T('common.delete')) + '</button>'
          : '') + '</td></tr>';
    });
    return html + '</tbody></table></div>';
  }

  function render() {
    const list = rangeEntries();
    computeConflicts(list);
    updateChrome();
    const ws = weekStart(S.anchor);
    let title;
    if (S.view === 'week') title = weekLabel(S.anchor) + ' · ' + ws + ' — ' + addDays(ws, 6);
    else if (S.view === 'day') title = S.anchor + ' · ' + T('wd.long.' + weekdayOf(S.anchor));
    else title = T('view.count', { n: list.length });
    $('view-title').textContent = title;
    $('view-sub').textContent = T('view.count', { n: list.length }) + (S.localMode ? ' · data.js' : '');
    const allDates = dataDates();
    if (allDates.length) {
      $('view-date').min = allDates[0];
      $('view-date').max = allDates[allDates.length - 1];
    }
    $('view-date').value = S.anchor;
    $('meta-week').textContent = weekLabel(S.anchor);

    let html;
    if (!list.length) {
      const hasFilter = S.filters.keyword || S.filters.group ||
        S.filters.teacher || S.filters.week || S.filters.faculty || S.filters.subgroup;
      const noKey = S.view === 'day' ? 'view.noCoursesDay'
        : (S.view === 'list' ? 'view.noMatch' : 'view.noCourses');
      html = emptyHtml(hasFilter ? T('view.noMatch') : T(noKey));
    } else if (S.view === 'week') html = renderWeek(list);
    else if (S.view === 'day') html = renderDay(list);
    else html = renderList(list);
    $('view-container').innerHTML = html;
  }

  /* ------------------------------------------------------------ 导出课表图片（纯 Canvas，无第三方依赖） */
  function exportScheduleImage() {
    const list = rangeEntries().slice().sort((a, b) =>
      String(a['日期']).localeCompare(String(b['日期'])) || a._start - b._start);
    if (!list.length) { toast(T('view.noMatch'), 'error'); return; }

    const FONT = '"Segoe UI", Arial, "Microsoft YaHei", sans-serif';
    const C = {
      surface: '#ffffff', line: '#e2e6ec', text: '#1b1f24', muted: '#667085',
      yellow: '#ffd43b', yellowSoft: '#fff8db', blue: '#2a6fb0', blueSoft: '#eaf2fb', red: '#c0392b'
    };
    // 用离屏 canvas 测量文字宽度
    const meas = document.createElement('canvas').getContext('2d');
    function wrap(text, maxW, maxLines) {
      const words = String(text == null ? '' : text).split(/\s+/).filter(Boolean);
      const out = []; let cur = '';
      for (const w of words) {
        const t = cur ? cur + ' ' + w : w;
        if (meas.measureText(t).width <= maxW) { cur = t; continue; }
        if (cur) { out.push(cur); cur = w; } else { out.push(w); cur = ''; }
        if (out.length >= maxLines) break;
      }
      if (cur && out.length < maxLines) out.push(cur);
      if (out.length > maxLines) out.length = maxLines;
      return out;
    }
    function rr(ctx, x, y, w, h, r) {
      r = Math.min(r, w / 2, h / 2);
      ctx.beginPath();
      ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
    }
    function measureCard(e, w) {
      const inner = w - 22;
      meas.font = '600 14px ' + FONT; const nl = wrap(displayCourse(e), inner, 3);
      meas.font = '12px ' + FONT;
      const sl = wrap([e['教师'], e['教室']].filter(Boolean).join(' · '), inner, 2);
      meas.font = '11px ' + FONT; const tl = wrap(e['时间'] || '', inner, 2);
      const h = 24 + nl.length * 18 + (sl.length ? 6 + sl.length * 16 : 0) + (tl.length ? 6 + tl.length * 14 : 0);
      return { h, nl, sl, tl };
    }
    function paintCard(ctx, e, x, y, w, m) {
      const marked = isModified(e) && !e._event;
      ctx.fillStyle = marked ? C.yellowSoft : C.surface;
      rr(ctx, x, y, w, m.h, 8); ctx.fill();
      ctx.strokeStyle = e._status === 'cancelled' ? '#e5b7b2' : C.line; ctx.lineWidth = 1; ctx.stroke();
      ctx.fillStyle = marked ? '#e0a800' : C.blue;
      rr(ctx, x, y + 8, 3, Math.max(4, m.h - 16), 1.5); ctx.fill();
      let ty = y + 26;
      ctx.fillStyle = C.text; ctx.font = '600 14px ' + FONT;
      m.nl.forEach(l => { ctx.fillText(l, x + 11, ty); ty += 18; });
      if (m.sl.length) {
        ty += 2; ctx.fillStyle = C.muted; ctx.font = '12px ' + FONT;
        m.sl.forEach(l => { ctx.fillText(l, x + 11, ty); ty += 16; });
      }
      if (m.tl.length) {
        ty += 2; ctx.fillStyle = marked ? '#8a6d00' : C.blue; ctx.font = '11px ' + FONT;
        m.tl.forEach(l => { ctx.fillText(l, x + 11, ty); ty += 14; });
      }
    }

    // ---- 第一遍：按当前视图计算画布尺寸 ----
    const view = S.view;
    let W = 1480, H = 400, extra = null;
    const PAD = 24, TOP = 104;
    if (view === 'week') {
      const gap = 10, colW = (W - PAD * 2 - gap * 6) / 7;
      const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart(S.anchor), i));
      const rowsByDay = days.map(d => list.filter(e => e['日期'] === d));
      const metrics = rowsByDay.map(rows => rows.map(e => measureCard(e, colW - 12)));
      const colH = metrics.map(ms => Math.max(110, 10 + ms.reduce((s, m) => s + m.h + 8, 0)));
      extra = { colW, gap, days, rowsByDay, metrics, colH };
      H = TOP + 48 + Math.max.apply(null, colH) + PAD;
    } else if (view === 'day') {
      W = 1000;
      const rows = list.slice();
      const cardW = W - PAD * 2 - 116;
      const metrics = rows.map(e => measureCard(e, cardW));
      extra = { rows, cardW, metrics };
      H = TOP + 12 + metrics.reduce((s, m) => s + m.h + 10, 0) + PAD;
    } else {
      W = 1500;
      const cap = 300;
      extra = { rows: list.slice(0, cap), truncated: list.length > cap };
      H = TOP + 38 + extra.rows.length * 32 + PAD + (extra.truncated ? 30 : 0);
    }
    H = Math.min(H, 16000);

    // ---- 第二遍：绘制 ----
    const dpr = 2;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.fillStyle = C.surface; ctx.fillRect(0, 0, W, H);

    // 顶部标题
    ctx.fillStyle = C.yellow; ctx.fillRect(0, 0, W, 6);
    ctx.fillStyle = C.text; ctx.font = '700 24px ' + FONT;
    const headTitle = (S.space === 'mine' ? T('space.mine') : T('page.schedule')) + ' · ' + weekLabel(S.anchor);
    ctx.fillText(headTitle, PAD, 48);
    ctx.fillStyle = C.muted; ctx.font = '13px ' + FONT;
    const sub = (view === 'week' ? weekStart(S.anchor) + ' — ' + addDays(weekStart(S.anchor), 6) : S.anchor) +
      ' · ' + T('view.count', { n: list.length });
    ctx.fillText(sub, PAD, 74);
    ctx.strokeStyle = C.line; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(PAD, 92); ctx.lineTo(W - PAD, 92); ctx.stroke();

    if (view === 'week') {
      const { colW, gap, days, rowsByDay, metrics, colH } = extra;
      const bandY = TOP, colTop = TOP + 48;
      ctx.fillStyle = C.blueSoft; rr(ctx, PAD, bandY, W - PAD * 2, 40, 8); ctx.fill();
      const maxH = Math.max.apply(null, colH);
      for (let i = 0; i < 7; i++) {
        const x = PAD + i * (colW + gap);
        ctx.fillStyle = '#fafbfc'; rr(ctx, x, colTop, colW, maxH, 8); ctx.fill();
        ctx.strokeStyle = C.line; ctx.stroke();
        // 星期表头
        ctx.fillStyle = i === 6 ? C.red : C.text;
        ctx.font = '700 14px ' + FONT;
        ctx.fillText(T('wd.' + weekdayOf(days[i])), x + 12, bandY + 26);
        ctx.fillStyle = C.muted; ctx.font = '12px ' + FONT;
        ctx.fillText(days[i].slice(5), x + colW - 46, bandY + 26);
        // 课程卡片
        let y = colTop + 10;
        rowsByDay[i].forEach((e, j) => { paintCard(ctx, e, x + 6, y, colW - 12, metrics[i][j]); y += metrics[i][j].h + 8; });
      }
    } else if (view === 'day') {
      const { rows, cardW, metrics } = extra;
      let y = TOP + 8;
      rows.forEach((e, i) => {
        ctx.fillStyle = C.blue; ctx.font = '600 13px ' + FONT;
        ctx.fillText(e['时间'] || '', PAD, y + 24);
        paintCard(ctx, e, PAD + 116, y, cardW, metrics[i]);
        y += metrics[i].h + 10;
      });
    } else {
      const cols = [
        [T('detail.date'), 110], [T('detail.weekday'), 60], [T('detail.time'), 110],
        [T('detail.group'), 160], [T('detail.nameRu'), 330], [T('detail.teacher'), 150],
        [T('detail.room'), 130], [T('detail.status'), 90]
      ];
      const tableX = PAD, tableY = TOP, rowH = 32;
      ctx.fillStyle = C.blueSoft; ctx.fillRect(tableX, tableY, W - PAD * 2, 38);
      ctx.font = '600 12px ' + FONT; ctx.fillStyle = C.text;
      let cx = tableX;
      cols.forEach(([label, w]) => { ctx.fillText(label, cx + 8, tableY + 25); cx += w; });
      extra.rows.forEach((e, i) => {
        const y = tableY + 38 + i * rowH;
        if (i % 2 === 1) { ctx.fillStyle = '#fafbfc'; ctx.fillRect(tableX, y, W - PAD * 2, rowH); }
        ctx.font = '12px ' + FONT; ctx.fillStyle = C.text;
        cx = tableX;
        const cells = [e['日期'], T('wd.' + e._wd), e['时间'], e['班级'], displayCourse(e),
          e['教师'], e['教室'], statusLabel(e._status)];
        cells.forEach((v, j) => {
          const w = cols[j][1];
          ctx.save(); ctx.beginPath(); ctx.rect(cx, y, w, rowH); ctx.clip();
          ctx.fillText(String(v == null ? '' : v), cx + 8, y + 21);
          ctx.restore(); cx += w;
        });
      });
      if (extra.truncated) {
        ctx.fillStyle = C.muted; ctx.font = '12px ' + FONT;
        ctx.fillText(T('export.limit', { n: 300 }), PAD, tableY + 38 + extra.rows.length * rowH + 22);
      }
    }

    canvas.toBlob(blob => {
      if (!blob) { toast(T('export.fail'), 'error'); return; }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'schedule-' + S.anchor + '.png'; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      toast(T('export.done'), 'ok');
    }, 'image/png');
  }

  /* ------------------------------------------------------------ 弹窗通用 */
  function showDlg(id) { $(id).classList.add('open'); }
  function hideDlg(id) { $(id).classList.remove('open'); }
  function needLogin() { toast(T('detail.needLogin'), 'error'); openAuth('login'); return false; }

  /* ------------------------------------------------------------ 登录 / 注册 */
  function openAuth(mode) {
    S.authMode = mode || 'login';
    const reg = S.authMode === 'register';
    $('auth-title').textContent = T(reg ? 'auth.registerTitle' : 'auth.loginTitle');
    $('auth-submit').textContent = T(reg ? 'auth.doRegister' : 'auth.doLogin');
    $('auth-toggle').textContent = T(reg ? 'auth.toLogin' : 'auth.toRegister');
    $('auth-name-row').classList.toggle('hidden', !reg);
    $('auth-error').textContent = '';
    $('auth-hint').textContent = T('auth.hint');
    showDlg('dlg-auth');
  }

  function authEmailValue() {
    const v = $('auth-email').value.trim();
    return v.indexOf('@') < 0 && v ? v + '@schedule.local' : v;
  }

  async function submitAuth() {
    const err = $('auth-error'); err.textContent = '';
    if (!S.firebaseReady) { err.textContent = T('admin.offline'); return; }
    const email = authEmailValue(), pwd = $('auth-password').value;
    if (!email || !pwd) { err.textContent = T('auth.errEmpty'); return; }
    if (S.authMode === 'register') {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { err.textContent = T('auth.errEmail'); return; }
      if (pwd.length < 6) { err.textContent = T('auth.errWeak'); return; }
    }
    const btn = $('auth-submit'); btn.disabled = true;
    try {
      if (S.authMode === 'register') {
        const cred = await FB.createUserWithEmailAndPassword(auth, email, pwd);
        // 注册不再选身份：统一按学生建档；教师/班级偏好仍在个人设置里配置
        await FB.setDoc(FB.doc(db, 'users', cred.user.uid), Object.assign(defaultProfile(), {
          uid: cred.user.uid, email: email, name: $('auth-name').value.trim(),
          role: 'student', lang: S.lang, createdAt: nowIso()
        }));
      } else {
        await FB.signInWithEmailAndPassword(auth, email, pwd);
      }
      hideDlg('dlg-auth');
      toast(S.authMode === 'register' ? T('auth.doRegister') : T('nav.user'), 'ok');
    } catch (e) {
      const code = String(e.code || '');
      if (code.indexOf('email-already-in-use') >= 0) err.textContent = T('auth.errUsed');
      else if (code.indexOf('invalid-credential') >= 0 || code.indexOf('wrong-password') >= 0) err.textContent = T('auth.errBad');
      else if (code.indexOf('weak-password') >= 0) err.textContent = T('auth.errWeak');
      else err.textContent = e.message;
    } finally { btn.disabled = false; }
  }

  async function sendReset() {
    const email = authEmailValue();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { $('auth-error').textContent = T('auth.errEmail'); return; }
    if (!S.firebaseReady) { $('auth-error').textContent = T('admin.offline'); return; }
    try {
      await FB.sendPasswordResetEmail(auth, email);
      toast(T('auth.resetSent'), 'ok');
    } catch (e) { toast(T('auth.resetFail') + ': ' + e.message, 'error'); }
  }

  /* ------------------------------------------------------------ 个人设置 */
  function openProfile() {
    if (!S.user) return needLogin();
    const opts = vals => '<option value="">' + esc(T('common.empty')) + '</option>' +
      vals.map(v => '<option value="' + esc(v) + '">' + esc(v) + '</option>').join('');
    $('p-group').innerHTML = opts(S.dict.groups || []);
    $('p-teacher').innerHTML = opts(S.dict.teachers || []);
    $('p-name').value = S.profile.name || '';
    $('p-faculty').value = S.profile.faculty || '';
    $('p-program').value = S.profile.program || '';
    $('p-group').value = S.profile.group || '';
    $('p-teacher').value = S.profile.teacher || '';
    $('p-defaultby').value = S.profile.defaultBy || 'group';
    $('p-lang').value = S.lang;
    showDlg('dlg-profile');
  }

  async function saveProfile() {
    if (!S.user) return needLogin();
    const p = S.profile;
    p.name = $('p-name').value.trim();
    p.faculty = $('p-faculty').value.trim();
    p.program = $('p-program').value.trim();
    p.group = $('p-group').value;
    p.teacher = $('p-teacher').value;
    p.defaultBy = $('p-defaultby').value;
    p.lang = $('p-lang').value;
    p.uid = S.user.uid; p.email = S.user.email || '';
    p.role = p.role === 'teacher' ? 'teacher' : 'student';
    if (S.cloudOK) {
      try { await FB.setDoc(FB.doc(db, 'users', S.user.uid), p); }
      catch (e) { toast(e.message, 'error'); return; }
    }
    S.lang = p.lang; localStorage.setItem('cm.lang', p.lang);
    applyI18n(); hideDlg('dlg-profile'); updateSpaceTabs(); render();
    toast(T('profile.saved'), 'ok');
  }

  /* ------------------------------------------------------------ 课程详情 */
  function openDetail(id) {
    const e = mergedEntries().find(x => x.id === id);
    if (!e) return;
    S.detailId = id;
    const mine = personalView();
    const kv = (k, v) => '<div class="k">' + esc(T(k)) + '</div><div>' + esc(v || T('common.empty')) + '</div>';
    const note = S.notes[id];
    let html = '<div class="kv">' +
      kv('detail.nameRu', displayCourse(e)) + kv('detail.nameZh', e._zh) +
      kv('detail.date', e['日期'] + ' · ' + T('wd.long.' + e._wd)) +
      kv('detail.time', e['时间']) + kv('detail.teacher', e['教师']) +
      kv('detail.room', e['教室']) + kv('detail.mode', modeLabel(e['授课形式'])) +
      kv('detail.group', e['班级']) + kv('detail.subgroup', e['小组']) +
      kv('detail.status', statusLabel(e._status)) + '</div>';

    html += '<div class="pill-list" style="margin-bottom:12px">' +
      (isModified(e) ? tagHtml(T('common.personal'), 'yellow') : tagHtml(T('common.official'), 'blue')) +
      (e._officialUpdated ? tagHtml(T('common.updated'), 'red') : '') +
      (S.conflictIds.has(id) ? tagHtml(T('view.conflict'), 'red') : '') + '</div>';

    // 备注是用户私有内容：只在个人课程表里出现，公共课表的详情不显示
    if (mine) {
      html += '<div class="section-title">' + esc(T('detail.notes')) + '</div>' +
        '<textarea id="d-note" placeholder="' + esc(T('detail.notePlaceholder')) + '">' + esc(note ? note.text : '') + '</textarea>' +
        '<div class="actions">' +
        '<button class="primary-btn" data-act="note-save">' + esc(T('detail.saveNote')) + '</button>' +
        '<button class="ghost-btn" data-act="note-del">' + esc(T('detail.deleteNote')) + '</button>' +
        '</div>';
    }

    if (mine) {
      html += '<div class="section-title">' + esc(T('common.personal')) + '</div><div class="actions">' +
        '<button class="ghost-btn" data-act="edit-personal">' + esc(T('detail.editPersonal')) + '</button>' +
        '<button class="ghost-btn" data-act="hide-personal">' + esc(T('detail.deletePersonal')) + '</button>' +
        '<button class="ghost-btn" data-act="report-error">' + esc(T('detail.reportError')) + '</button>' +
        '</div>';
    } else {
      // 公共课表详情不展示个人操作，只提供「添加课程」把这一门加入个人课表
      html += '<div class="actions">' +
        '<button class="primary-btn" data-act="add-personal">' + esc(T('detail.addCourse')) + '</button>' +
        '</div>';
    }

    if (S.isAdmin && S.cloudOK && !e._event) {
      html += '<div class="section-title">' + esc(T('nav.admin')) + '</div><div class="actions">' +
        '<button class="ghost-btn" data-act="edit-official">' + esc(T('edit.titleEdit')) + '</button>' +
        '<button class="ghost-btn" data-act="del-official">' + esc(T('common.delete')) + '</button>' +
        '</div>';
    }
    $('detail-body').innerHTML = html;
    // 星标也是个人操作，公共课表详情不显示
    const starBtn = $('detail-star');
    if (starBtn) starBtn.classList.toggle('hidden', !mine);
    updateStarBtn(!!(note && note.star));
    showDlg('dlg-detail');
  }

  function updateStarBtn(on) {
    const b = $('detail-star'); if (!b) return;
    b.textContent = on ? '★' : '☆';
    b.classList.toggle('on', !!on);
    b.title = T(on ? 'detail.starOff' : 'detail.starOn');
  }

  async function toggleStar() {
    if (!S.user || !S.cloudOK) return needLogin();
    const id = S.detailId; if (!id) return;
    const cur = S.notes[id] || {};
    const star = !cur.star;
    const key = hashId(S.user.uid + '|' + id);
    const data = { uid: S.user.uid, entryId: id, text: cur.text || '', star: star, updatedAt: nowIso() };
    try {
      await FB.setDoc(FB.doc(db, 'userNotes', key), data);
      S.notes[id] = { id: key, ...data };
      updateStarBtn(star);
      render();
      toast(T(star ? 'detail.starAdded' : 'detail.starRemoved'), 'ok');
    } catch (e) { toast(e.message, 'error'); }
  }

  async function saveNote(remove) {
    if (!S.user || !S.cloudOK) return needLogin();
    const id = S.detailId;
    const text = remove ? '' : ($('d-note') ? $('d-note').value.trim() : '');
    const key = hashId(S.user.uid + '|' + id);
    const star = !!(S.notes[id] && S.notes[id].star);
    try {
      if (text || star) {
        // 保留星标字段：删除备注不应清掉星标
        const data = { uid: S.user.uid, entryId: id, text: text, star: star, updatedAt: nowIso() };
        await FB.setDoc(FB.doc(db, 'userNotes', key), data);
        S.notes[id] = { id: key, ...data };
      } else {
        await FB.deleteDoc(FB.doc(db, 'userNotes', key));
        delete S.notes[id];
      }
      if ($('d-note')) $('d-note').value = text;
      render();
      toast(T('edit.saved'), 'ok');
    } catch (e) { toast(e.message, 'error'); }
  }

  /* ------------------------------------------------------------ 编辑弹窗 */
  function openEdit(ctx) {
    S.editCtx = ctx;
    const e = ctx.mode === 'event'
      ? { '课程': '', '日期': ctx.date || S.anchor, '时间': '', '教师': '', '教室': '', '授课形式': '', '班级': S.profile.group || '', '小组': '全部' }
      : (mergedEntries().find(x => x.id === ctx.id) || {});
    const titleKey = ctx.mode === 'official' ? 'edit.titleEdit' :
      (ctx.mode === 'event' ? 'edit.titleAdd' : 'detail.editPersonal');
    $('edit-title').textContent = T(titleKey);
    $('e-id').value = ctx.id || '';
    $('e-course').value = e['课程'] || '';
    $('e-date').value = e['日期'] || S.anchor;
    $('e-time').value = e['时间'] || '';
    $('e-teacher').value = e['教师'] || '';
    $('e-room').value = e['教室'] || '';
    $('e-mode').value = e['授课形式'] || '';
    $('e-group').value = e['班级'] || '';
    $('e-subgroup').value = e['小组'] || '全部';
    $('e-status').value = e._status || 'normal';
    $('e-type').value = (e._type || 'personal');
    $('e-type-row').classList.toggle('hidden', ctx.mode !== 'event');
    $('e-error').textContent = '';
    showDlg('dlg-edit');
  }

  function collectEdit() {
    return {
      '课程': $('e-course').value.trim(), '日期': $('e-date').value,
      '时间': $('e-time').value.trim(), '教师': $('e-teacher').value.trim(),
      '教室': $('e-room').value.trim(), '授课形式': $('e-mode').value.trim(),
      '班级': $('e-group').value.trim(), '小组': $('e-subgroup').value.trim() || '全部',
      _status: $('e-status').value
    };
  }

  async function saveEdit() {
    const ctx = S.editCtx; if (!ctx) return;
    const data = collectEdit();
    if (!data['日期'] || !data['课程']) { $('e-error').textContent = T('edit.errRequired'); return; }
    if ((ctx.mode === 'personal' || ctx.mode === 'event') && !S.user) return needLogin();
    try {
      if (ctx.mode === 'official') await saveOfficialEdit(ctx.id, data);
      else if (ctx.mode === 'personal') await savePersonalEdit(ctx.id, data);
      else await saveEventEdit(ctx.id, data);
      hideDlg('dlg-edit');
      toast(T('edit.saved'), 'ok');
      render();
    } catch (e) { $('e-error').textContent = e.message; }
  }

  /* ------------------------------------------------------------ 管理后台 */
  function openAdmin(mode) {
    if (!adminActive()) { toast(T('admin.needAdmin'), 'error'); return; }
    S.adminMode = mode || 'upload';
    const titles = {
      upload: 'admin.uploadTitle', migrate: 'admin.migrateTitle', courses: 'nav.courses',
      translations: 'admin.translations', uploads: 'admin.uploads', changelog: 'admin.changelog'
    };
    $('admin-title').textContent = T(titles[S.adminMode] || 'nav.admin');
    renderAdminBody();
    showDlg('dlg-admin');
  }

  function adminTable(headers, rows) {
    if (!rows.length) return '<div class="info-box">' + esc(T('view.noMatch')) + '</div>';
    return '<div style="max-height:52vh;overflow:auto"><table class="data-table"><thead><tr>' +
      headers.map(h => '<th>' + esc(h) + '</th>').join('') + '</tr></thead><tbody>' +
      rows.join('') + '</tbody></table></div>';
  }

  function renderAdminBody() {
    let html = '';
    if (S.localMode && ['uploads', 'changelog', 'migrate'].indexOf(S.adminMode) >= 0) {
      $('admin-body').innerHTML = '<div class="info-box warn">' + esc(T('admin.cloudOnly')) + '</div>';
      return;
    }
    if (S.localMode) html += '<div class="info-box warn" style="margin-bottom:10px">' + esc(T('admin.localModeWarn')) + '</div>';
    if (S.adminMode === 'upload') {
      const supported = DocxParser.supportsDeflateRaw();
      html += '<p class="hint">' + esc(T('admin.uploadHint')) + '</p>' +
        '<div class="dropzone" id="dropzone">' +
        '<input type="file" id="admin-files" multiple accept=".docx" style="display:none">' +
        '<input type="file" id="admin-datajs" accept=".js" style="display:none">' +
        '<button class="primary-btn" data-act="pick-files">' + esc(T('admin.chooseFiles')) + '</button> ' +
        '<button class="ghost-btn" data-act="pick-datajs">' + esc(T('admin.chooseDataJs')) + '</button>' +
        (supported ? '' : '<div class="info-box warn" style="margin-top:10px">' + esc(T('admin.noDeflate')) + '</div>') +
        '</div><div id="admin-preview" style="margin-top:12px"></div>';
    } else if (S.adminMode === 'migrate') {
      const n = (typeof scheduleData !== 'undefined' && scheduleData.length) || 0;
      html += '<p class="hint">' + esc(T('admin.migrateHint', { n: n })) + '</p>' +
        '<button class="primary-btn" data-act="do-migrate">' + esc(T('admin.migrateBtn')) + '</button>';
    } else if (S.adminMode === 'courses') {
      if (S.localMode) html += '<div class="info-box" style="margin-bottom:10px">' + esc(T('admin.localReadOnly')) + '</div>';
      html += '<input type="text" id="admin-search" class="ghost-btn" style="width:100%;margin-bottom:10px" placeholder="' +
        esc(T('filter.keyword')) + '"><div id="admin-course-list"></div>';
    } else if (S.adminMode === 'translations') {
      const rows = (S.dict.courses || []).map(name =>
        '<tr><td>' + esc(name) + '</td><td><input type="text" data-ru="' + esc(name) +
        '" value="' + esc(S.courseZh[name] || '') + '" style="width:100%;padding:5px;border:1px solid var(--line);border-radius:6px">' +
        '</td><td><button class="link-btn" data-act="save-translation" data-ru="' + esc(name) + '">' +
        esc(T('common.save')) + '</button></td></tr>').join('');
      html += '<p class="hint">' + esc(T('admin.translations')) + '</p>' +
        adminTable([T('admin.courseRu'), T('admin.courseZh'), ''], [rows]);
    } else if (S.adminMode === 'uploads') {
      const rows = S.uploads.slice().sort((a, b) => String(b.uploadedAt).localeCompare(String(a.uploadedAt)))
        .map(x => '<tr><td>' + esc(x.name) + '</td><td>' + esc(x.weekId || '—') + '</td><td>' +
          esc(fmtIso(x.uploadedAt)) + '</td><td>' + esc(x.rowCount || 0) + '</td><td>' +
          esc(x.stored ? T('admin.fileStored') : T('admin.fileMetaOnly')) + '</td><td>' +
          (x.blobId ? '<button class="link-btn" data-act="dl-file" data-id="' + esc(x.id) +
            '">' + esc(T('admin.downloadFile')) + '</button>' : '—') + '</td></tr>').join('');
      html += '<div class="section-title">' + esc(T('admin.uploads')) + '</div>' +
        adminTable([T('col.file'), T('col.week'), T('col.time'), T('col.rows'),
          T('admin.archive'), T('col.action')], [rows]);
      html += '<p class="hint">' + esc(T('admin.storageReplaced')) + '</p>';
      const vers = S.versions.slice().sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)))
        .map(x => '<tr><td>' + esc(x.weekId) + '</td><td>' + esc(fmtIso(x.publishedAt)) + '</td><td>' +
          esc(x.entryCount || 0) + '</td><td>' + esc(x.publishedBy || '') + '</td></tr>').join('');
      html += '<div class="section-title">' + esc(T('admin.versions')) + '</div>' +
        adminTable([T('col.week'), T('col.time'), T('col.rows'), T('col.by')], [vers]);
    } else if (S.adminMode === 'changelog') {
      const rows = S.logs.slice().sort((a, b) => String(b.at).localeCompare(String(a.at)))
        .map(x => '<tr><td>' + esc(fmtIso(x.at)) + '</td><td>' + esc(x.action) + '</td><td>' +
          esc(x.target) + '</td><td>' + esc(x.detail || '') + '</td></tr>').join('');
      html += adminTable([T('col.time'), T('col.action'), T('col.object'), T('col.detail')], [rows]);
    }
    $('admin-body').innerHTML = html;
    if (S.adminMode === 'upload' && S.pending) renderPendingPreview();
    if (S.adminMode === 'courses') renderAdminCourses('');
  }

  function renderAdminCourses(q) {
    const list = S.entries.filter(e => e._active &&
      (!q || [e['日期'], e['课程'], e['教师'], e['班级']].join(' ').toLowerCase().indexOf(q.toLowerCase()) >= 0))
      .slice(0, 300);
    const rows = list.map(e => '<tr data-id="' + esc(e.id) + '"><td>' + esc(e['日期']) + '</td><td>' +
      esc(e['时间']) + '</td><td>' + esc(e['课程']) + '</td><td>' + esc(e['教师']) + '</td><td>' +
      esc(e['班级']) + '</td><td>' + esc(statusLabel(e._status)) + '</td><td>' +
      (S.cloudOK && S.isAdmin
        ? '<button class="link-btn" data-act="edit-official" data-id="' + esc(e.id) + '">' + esc(T('common.edit')) + '</button>' +
          '<button class="link-btn danger" data-act="del-official" data-id="' + esc(e.id) + '">' + esc(T('common.delete')) + '</button>'
        : '—') +
      '</td></tr>').join('');
    const el = $('admin-course-list');
    if (el) el.innerHTML = adminTable([
      T('col.date'), T('col.time'), T('col.course'), T('col.teacher'),
      T('col.group'), T('col.state'), T('col.action')
    ], [rows]);
  }

  function detectPendingConflicts(rows) {
    const bySlot = {}, found = [];
    rows.forEach((r, i) => {
      if (!r['时间']) return;
      const k = r['日期'] + '|' + timeRange(r['时间']).join('-');
      (bySlot[k] || (bySlot[k] = [])).push(r);
    });
    Object.values(bySlot).forEach(arr => {
      if (arr.length < 2) return;
      ['教师', '教室', '班级'].forEach(field => {
        const m = {};
        arr.forEach(r => {
          const v = String(r[field] || '').trim();
          if (v && v !== '网课') (m[v] || (m[v] = [])).push(r);
        });
        Object.values(m).forEach(g => {
          if (g.length > 1) found.push({ field: field, value: g[0][field], date: g[0]['日期'], time: g[0]['时间'], count: g.length });
        });
      });
    });
    return found;
  }

  function renderPendingPreview() {
    const el = $('admin-preview'); if (!el || !S.pending) return;
    const p = S.pending;
    const conflicts = detectPendingConflicts(p.rows);
    const weeks = [...new Set(p.rows.map(r => weekStart(r['日期'])))];
    let html = '<div class="info-box">' + esc(T('admin.parsed', { n: p.rows.length, f: p.summaries.length })) +
      '<br>' + esc(weeks.map(w => w + ' ~ ' + addDays(w, 6)).join(' / ')) + '</div>';
    html += '<div class="info-box warn" style="margin-top:8px">' +
      esc(T(S.localMode ? 'admin.localExportHint' : 'admin.wholeWeekWarn')) + '</div>';
    const unresolved = p.unresolved || [];
    if (unresolved.length) {
      html += '<div class="info-box warn" style="margin-top:8px"><strong>' +
        esc(T('admin.unresolvedTitle', { n: unresolved.length })) + '</strong>' +
        unresolved.map(n =>
          '<div style="margin-top:8px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">' +
          '<span style="word-break:break-all">' + esc(n) + '</span>' +
          '<input type="date" data-date-for="' + esc(n) + '" value="' + esc(S.dateOverrides[n] || '') + '">' +
          '</div>').join('') +
        '<div style="margin-top:10px"><button class="ghost-btn" data-act="apply-dates">' +
        esc(T('admin.applyDates')) + '</button></div></div>';
    }
    if (p.warnings.length) {
      html += '<div class="info-box warn" style="margin-top:8px">' +
        esc(T('admin.warnings', { n: p.warnings.length })) + '<br>' +
        p.warnings.slice(0, 8).map(w => esc(w.file + ' · ' + w.issue + (w.text ? ' · ' + w.text.slice(0, 60) : ''))).join('<br>') +
        '</div>';
    }
    html += '<div class="info-box ' + (conflicts.length ? 'warn' : '') + '" style="margin-top:8px">' +
      esc(conflicts.length ? T('admin.conflicts', { n: conflicts.length }) : T('admin.noConflicts')) +
      (conflicts.length ? '<br>' + conflicts.slice(0, 8).map(c =>
        esc(c.date + ' ' + c.time + ' · ' + c.field + '=' + c.value + ' ×' + c.count)).join('<br>') : '') + '</div>';
    html += '<p class="hint" style="margin-top:10px">' + esc(unresolved.length
      ? T('admin.fixDatesFirst') : (S.localMode ? T('admin.localModeWarn') : T('admin.publishHint'))) + '</p>' +
      '<div class="actions"><button class="primary-btn" data-act="do-publish"' +
      (unresolved.length ? ' disabled' : '') + '>' +
      esc(S.localMode ? T('admin.exportDataJs') : T('admin.publish')) + '</button>' +
      '<button class="ghost-btn" data-act="cancel-pending">' + esc(T('admin.cancelPending')) + '</button></div>';
    el.innerHTML = html;
  }

  /* ------------------------------------------------------------ 数据写操作 */
  function cleanEntry(e) {
    const o = {};
    FIELDS.forEach(k => { o[k] = e[k] == null ? '' : e[k]; });
    ['_week', '_wd', '_start', '_status', '_active', '_faculty', '_version',
      '_publishedAt', '_updatedAt', '_sync'].forEach(k => {
      if (e[k] !== undefined) o[k] = e[k];
    });
    return o;
  }

  async function saveOfficialEdit(id, data) {
    const base = S.entries.find(e => e.id === id) || {};
    const merged = Object.assign({}, base, data);
    const e = normalizeEntry(merged, id);
    e._version = base._version || '';
    e._publishedAt = base._publishedAt || nowIso();
    e._updatedAt = nowIso();
    e._active = true;
    const payload = cleanEntry(e);
    if (id && S.cloudOK) {
      await FB.setDoc(FB.doc(db, 'scheduleEntries', id), payload);
      Object.assign(S.entries.find(x => x.id === id), e);
    } else if (S.cloudOK) {
      const ref = await FB.addDoc(FB.collection(db, 'scheduleEntries'), payload);
      S.entries.push(normalizeEntry(payload, ref.id));
    } else { toast(T('admin.offline'), 'error'); return; }
    buildDict(); initFilterOptions();
    await writeLog(id ? 'update' : 'create', e['课程'] + ' / ' + e['日期'], JSON.stringify(data));
  }

  async function savePersonalEdit(id, data) {
    const official = S.entries.find(e => e.id === id);
    if (!official) { toast(T('view.noMatch'), 'error'); return; }
    const patch = {};
    Object.keys(data).forEach(k => {
      if (String(official[k] == null ? '' : official[k]) !== String(data[k])) patch[k] = data[k];
    });
    if (patch['日期'] !== undefined) patch['星期'] = '周' + '一二三四五六日'[weekdayOf(patch['日期']) - 1];
    const key = hashId(S.user.uid + '|' + id);
    const rec = { uid: S.user.uid, entryId: id, patch: patch, deleted: false, createdAt: nowIso() };
    await FB.setDoc(FB.doc(db, 'userScheduleOverrides', key), rec);
    S.overrides[id] = { id: key, ...rec };
  }

  async function saveEventEdit(id, data) {
    const rec = {
      uid: S.user.uid, title: data['课程'], date: data['日期'], time: data['时间'],
      room: data['教室'], group: data['班级'], type: $('e-type').value,
      status: data._status, updatedAt: nowIso()
    };
    let key = id;
    if (key && S.events.some(e => e.id === key)) await FB.setDoc(FB.doc(db, 'userEvents', key), rec);
    else {
      const ref = await FB.addDoc(FB.collection(db, 'userEvents'), rec);
      key = ref.id;
    }
    const idx = S.events.findIndex(e => e.id === key);
    if (idx >= 0) S.events[idx] = { id: key, ...rec }; else S.events.push({ id: key, ...rec });
  }

  async function hidePersonal(id) {
    if (!S.user || !S.cloudOK) return needLogin();
    const key = hashId(S.user.uid + '|' + id);
    const old = S.overrides[id] || {};
    // 保留原 patch：只是从「我的课表」隐藏，不丢掉之前的个人修改
    const rec = { uid: S.user.uid, entryId: id, patch: old.patch || {}, deleted: true, createdAt: nowIso() };
    await FB.setDoc(FB.doc(db, 'userScheduleOverrides', key), rec);
    S.overrides[id] = { id: key, ...rec };
    toast(T('edit.deleted'), 'ok'); render();
  }

  async function restoreOfficial(id) {
    if (!S.user || !S.cloudOK) return needLogin();
    const ov = S.overrides[id];
    const key = ov ? ov.id : hashId(S.user.uid + '|' + id);
    // 恢复 = 取消隐藏并放回个人课表，而不是删除覆盖记录让课程只留在公共课表
    const rec = {
      uid: S.user.uid, entryId: id,
      patch: (ov && ov.patch) || {}, deleted: false, createdAt: nowIso()
    };
    await FB.setDoc(FB.doc(db, 'userScheduleOverrides', key), rec);
    S.overrides[id] = { id: key, ...rec };
    toast(T('edit.restored'), 'ok'); render();
  }

  // 公共详情「添加课程」：只把当前这一门课程加入个人课表
  async function addPersonal(id) {
    if (!S.user) return needLogin();
    if (!S.cloudOK) { toast(T('admin.offline'), 'error'); return; }
    const official = S.entries.find(e => e.id === id);
    if (!official || official._active === false) { toast(T('view.noMatch'), 'error'); return; }
    if (S.overrides[id]) { toast(T('saveSchedule.already'), 'ok'); return; }
    const key = hashId(S.user.uid + '|' + id);
    const rec = { uid: S.user.uid, entryId: id, patch: {}, deleted: false, createdAt: nowIso() };
    try {
      await FB.setDoc(FB.doc(db, 'userScheduleOverrides', key), rec);
      S.overrides[id] = { id: key, ...rec };
      toast(T('saveSchedule.done', { n: 1 }), 'ok');
      render();
    } catch (e) { toast(e.message, 'error'); }
  }

  // 保存课表：把当前视图里可见的公共课程整批写入个人课表（userScheduleOverrides），需登录
  async function saveScheduleToMine() {
    if (!S.user) return needLogin();
    if (!S.cloudOK) { toast(T('admin.offline'), 'error'); return; }
    const list = rangeEntries().filter(e => !e._event && !e._saved);
    if (!list.length) { toast(T('saveSchedule.empty'), 'error'); return; }
    // 已存在的个人覆盖不重复写入
    const items = list.filter(e => !S.overrides[e.id]);
    if (!items.length) { toast(T('saveSchedule.already'), 'ok'); return; }
    let ok = 0;
    try {
      await chunkedBatch(items, (batch, e) => {
        const key = hashId(S.user.uid + '|' + e.id);
        batch.set(FB.doc(db, 'userScheduleOverrides', key), {
          uid: S.user.uid, entryId: e.id, patch: {}, deleted: false, createdAt: nowIso()
        });
        ok++;
      });
      items.forEach(e => {
        const key = hashId(S.user.uid + '|' + e.id);
        S.overrides[e.id] = { id: key, uid: S.user.uid, entryId: e.id, patch: {}, deleted: false, createdAt: nowIso() };
      });
      toast(T('saveSchedule.done', { n: ok }), 'ok');
      render();
    } catch (e) { toast(e.message, 'error'); }
  }

  // 恢复已删课程：列出所有被删除的个人覆盖，可逐条恢复（即便课程已不在课表中显示）
  function openRestore() {
    if (!S.user) return needLogin();
    if (!personalView()) return;   // 仅个人课表可恢复
    if (!S.cloudOK) { toast(T('admin.offline'), 'error'); return; }
    const removed = Object.values(S.overrides).filter(o => o.deleted);
    let html = '';
    if (!removed.length) {
      html = '<p class="hint">' + esc(T('restore.empty')) + '</p>';
    } else {
      html = '<div class="restore-list">';
      removed.forEach(o => {
        const e = S.entries.find(x => x.id === o.entryId) || {};
        html += '<div class="restore-item">' +
          '<div class="restore-info"><strong>' + esc(displayCourse(e) || o.entryId) + '</strong>' +
          '<span>' + esc([e['日期'], e['时间'], e['教师']].filter(Boolean).join(' · ')) + '</span></div>' +
          '<button class="ghost-btn" data-act="restore-pick" data-id="' + esc(o.entryId) + '">' +
          esc(T('detail.restoreOfficial')) + '</button></div>';
      });
      html += '</div>';
    }
    $('restore-body').innerHTML = html;
    showDlg('dlg-restore');
  }

  async function deleteOfficial(id) {
    if (!S.isAdmin || !S.cloudOK) { toast(T('admin.needAdmin'), 'error'); return; }
    const e = S.entries.find(x => x.id === id);
    await FB.deleteDoc(FB.doc(db, 'scheduleEntries', id));
    S.entries = S.entries.filter(x => x.id !== id);
    buildDict(); initFilterOptions();
    await writeLog('delete', (e && e['课程']) || id, (e && e['日期']) || '');
    hideDlg('dlg-detail');
    toast(T('edit.deleted'), 'ok'); render();
  }

  async function reportError(id) {
    if (!S.user || !S.cloudOK) return needLogin();
    const e = mergedEntries().find(x => x.id === id) || {};
    await FB.addDoc(FB.collection(db, 'errorReports'), {
      uid: S.user.uid, entryId: id, course: e['课程'] || '', date: e['日期'] || '', at: nowIso()
    });
    toast(T('detail.reportDone'), 'ok');
  }

  async function saveTranslation(ru) {
    const input = $('admin-body').querySelector('input[data-ru="' + CSS.escape(ru) + '"]');
    if (!input) return;
    const zh = input.value.trim();
    S.courseZh[ru] = zh;
    if (!S.cloudOK) {
      writeStore('cm.localZh', S.courseZh);
      toast(T('admin.localTranslationSaved'), 'ok'); render(); return;
    }
    await FB.setDoc(FB.doc(db, 'courseDict', hashId(ru)), { ru: ru, zh: zh });
    toast(T('admin.translationSaved'), 'ok'); render();
  }

  /* ------------------------------------------------------------ 上传解析 */
  async function handleFiles(fileList, kind) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    setLoading(true, T('admin.parsing'));
    try {
      if (kind === 'docx') {
        const buffers = [];
        for (const f of files) buffers.push({ name: f.name, buffer: await f.arrayBuffer() });
        const r = await DocxParser.parseAllFiles(buffers, S.dateOverrides);
        S.pending = {
          rows: r.rows, warnings: r.warnings, summaries: r.summaries,
          files: r.files, unresolved: r.unresolved || [], source: 'docx'
        };
      } else {
        const text = await files[0].text();
        const rows = DocxParser.parseDataJs(text);
        S.pending = {
          rows: rows, warnings: [], summaries: [{ name: files[0].name, count: rows.length }],
          files: [], unresolved: [], source: 'data.js'
        };
      }
      renderPendingPreview();
    } catch (e) {
      toast(T('admin.parseFail', { m: e.message }), 'error');
    } finally { setLoading(false); }
  }

  async function applyDateOverrides() {
    const p = S.pending;
    if (!p || !p.files.length) return;
    const inputs = $('admin-body').querySelectorAll('input[data-date-for]');
    Array.from(inputs || []).forEach(inp => {
      if (inp.value) S.dateOverrides[inp.dataset.dateFor] = inp.value;
    });
    setLoading(true, T('admin.parsing'));
    try {
      const r = await DocxParser.parseAllFiles(p.files, S.dateOverrides);
      p.rows = r.rows; p.warnings = r.warnings; p.summaries = r.summaries;
      p.files = r.files; p.unresolved = r.unresolved || [];
      renderPendingPreview();
      toast(p.unresolved.length ? T('admin.fixDatesFirst') : T('admin.dateApplied'),
        p.unresolved.length ? 'error' : 'ok');
    } catch (e) {
      toast(T('admin.parseFail', { m: e.message }), 'error');
    } finally { setLoading(false); }
  }

  function doMigrate() {
    const rows = (typeof scheduleData !== 'undefined' && Array.isArray(scheduleData)) ? scheduleData : [];
    if (!rows.length) { toast(T('view.noMatch'), 'error'); return; }
    S.pending = {
      rows: rows, warnings: [], summaries: [{ name: 'data.js', count: rows.length }],
      files: [], unresolved: [], source: 'data.js'
    };
    publishPending();
  }

  /* ------------------------------------------------------------ 本地模式导出 data.js */
  function exportLocalDataJs() {
    const p = S.pending;
    if ((p.unresolved || []).length) { toast(T('admin.fixDatesFirst'), 'error'); return; }
    const clean = rows => rows.map(e => {
      const o = {};
      FIELDS.forEach(k => { o[k] = e[k] == null ? '' : e[k]; });
      return o;
    });
    // 本地导出是「增量生成 data.js」：只替换同名来源文件的旧记录，不按整周删除
    const names = new Set(uniq(p.rows.map(r => r['来源文件'])));
    const kept = S.entries.filter(e => !names.has(e['来源文件']));
    const removed = S.entries.length - kept.length;
    const weeks = [...new Set(p.rows.map(r => weekStart(r['日期'])))];
    const out = clean(kept).concat(clean(p.rows));
    out.sort((a, b) => String(a['日期']).localeCompare(String(b['日期'])) ||
      String(a['时间']).localeCompare(String(b['时间'])));
    const text = 'const scheduleData = ' + JSON.stringify(out) + ';\r\n';
    try {
      const url = URL.createObjectURL(new Blob([text], { type: 'text/javascript;charset=utf-8' }));
      const a = document.createElement('a');
      a.href = url; a.download = 'data.js';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 3000);
    } catch (e) { toast(T('admin.parseFail', { m: e.message }), 'error'); return; }
    S.entries = out.map((r, i) => normalizeEntry(r, 'local-' + i));
    S.pending = null;
    buildDict(); initFilterOptions();
    hideDlg('dlg-admin');
    updateChrome(); render();
    toast(T('admin.exportDone', {
      n: out.length, r: removed, f: p.summaries.length, w: weeks.length
    }), 'ok');
  }

  /* ------------------------------------------------------------ 发布（按周版本化） */
  async function publishPending() {
    const p = S.pending;
    if (!p || !p.rows.length) { toast(T('view.noMatch'), 'error'); return; }
    if ((p.unresolved || []).length) { toast(T('admin.fixDatesFirst'), 'error'); return; }
    if (S.localMode) { exportLocalDataJs(); return; }
    if (!S.isAdmin || !S.cloudOK) { toast(T('admin.needAdmin'), 'error'); return; }
    const weeks = [...new Set(p.rows.map(r => weekStart(r['日期'])))];
    const syncId = 'sync-' + Date.now();
    const versionId = 'v-' + Date.now();
    const publishedAt = nowIso();
    let oldIds = [], staleIds = [];
    setLoading(true, T('admin.publishing'));

    try {
      const snap = await FB.getDocs(FB.collection(db, 'scheduleEntries'));
      snap.docs.forEach(d => {
        const x = d.data();
        if (weeks.indexOf(x._week) >= 0 && x._active !== false) oldIds.push(d.id);
        else if (x._active === false) staleIds.push(d.id);
      });

      // 原始 Word 归档到 Firestore：Firebase Storage 在国内网络下常连不上，
      // 而且旧实现只存不取（没有下载入口），换成 base64 存独立集合更可靠。
      const storedMap = {};
      if (p.files.length) {
        for (const f of p.files) {
          try {
            const day = f.date || DocxParser.dateFromFilename(f.name);
            const blobId = versionId + '-' + hashId(f.name);
            await FB.setDoc(FB.doc(db, 'uploadedFileBlobs', blobId), {
              name: f.name, weekId: day ? weekStart(day) : '', versionId: versionId,
              size: f.buffer.byteLength, base64: bufToBase64(f.buffer), uploadedAt: publishedAt,
              _sync: syncId
            });
            storedMap[f.name] = blobId;
          } catch (e) {
            console.warn('原始 Word 归档失败：', f.name, e);
            storedMap[f.name] = '';
          }
        }
      }

      const payloads = p.rows.map(r => {
        const e = normalizeEntry(r, null);
        e._version = versionId; e._publishedAt = publishedAt; e._active = true; e._sync = syncId;
        return cleanEntry(e);
      });
      await chunkedBatch(payloads, (batch, row) =>
        batch.set(FB.doc(FB.collection(db, 'scheduleEntries')), row));

      await chunkedBatch(oldIds, (batch, id) =>
        batch.update(FB.doc(db, 'scheduleEntries', id), { _active: false, _sync: syncId + '-old' }));

      await chunkedBatch(weeks, (batch, w) =>
        batch.set(FB.doc(FB.collection(db, 'scheduleVersions')), {
          weekId: w, versionId: versionId, publishedAt: publishedAt,
          publishedBy: S.user ? S.user.email : '', _sync: syncId,
          entryCount: payloads.filter(x => x._week === w).length
        }));

      await chunkedBatch(p.summaries, (batch, s) =>
        batch.set(FB.doc(FB.collection(db, 'uploadedFiles')), {
          name: s.name, weekId: s.date ? weekStart(s.date) : '',
          uploadedAt: publishedAt, rowCount: s.count || 0, versionId: versionId,
          stored: !!storedMap[s.name], blobId: storedMap[s.name] || '', _sync: syncId
        }));

      const dictRows = {
        faculties: ['МАГ'],
        programs: uniq(p.rows.map(r => r['专业'])),
        groups: uniq(p.rows.map(r => r['班级'])),
        teachers: uniq(p.rows.map(r => r['教师'])),
        courseDict: uniq(p.rows.map(r => r['课程']))
      };
      for (const col of Object.keys(dictRows)) {
        await chunkedBatch(dictRows[col], (batch, v) => {
          const data = col === 'courseDict' ? { ru: v, zh: S.courseZh[v] || '' } : { name: v, label: v };
          batch.set(FB.doc(db, col, hashId(v)), data);
        });
      }
      await FB.addDoc(FB.collection(db, 'changeLogs'), {
        uid: S.user ? S.user.uid : '', at: publishedAt, action: 'publish',
        target: weeks.join(','), detail: payloads.length + ' rows / ' + p.summaries.length + ' files',
        _sync: syncId
      });

      // 清理更早的失效版本（失败不影响本次发布结果）
      try {
        await chunkedBatch(staleIds.slice(0, 2000), (batch, id) =>
          batch.delete(FB.doc(db, 'scheduleEntries', id)));
      } catch (e) { console.warn('旧版本清理跳过：', e); }

      toast(T('admin.publishDone', { n: payloads.length, w: weeks.length }), 'ok');
      S.pending = null;
      hideDlg('dlg-admin');
      await loadCloud();
    } catch (e) {
      console.error('发布失败：', e);
      try {
        for (const c of ['scheduleEntries', 'scheduleVersions', 'uploadedFiles', 'uploadedFileBlobs', 'changeLogs']) {
          const s = await FB.getDocs(FB.query(FB.collection(db, c), FB.where('_sync', '==', syncId)));
          await chunkedBatch(s.docs.map(d => d.id), (batch, id) => batch.delete(FB.doc(db, c, id)));
        }
        await chunkedBatch(oldIds, (batch, id) =>
          batch.update(FB.doc(db, 'scheduleEntries', id), { _active: true }));
      } catch (cleanupErr) { console.error('回滚失败：', cleanupErr); }
      toast(T('admin.publishFail', { m: e.message }), 'error');
      await loadCloud();
    } finally { setLoading(false); }
  }

  // 按需读取归档的原始 Word 并触发浏览器下载（不进常规列表查询，避免每页加载都拉 base64）
  async function downloadArchivedFile(id) {
    if (!S.cloudOK || !S.isAdmin) { toast(T('admin.needAdmin'), 'error'); return; }
    try {
      const m = await FB.getDoc(FB.doc(db, 'uploadedFiles', id));
      const meta = m.data();
      if (!meta || !meta.blobId) { toast(T('admin.noBlob'), 'error'); return; }
      const b = await FB.getDoc(FB.doc(db, 'uploadedFileBlobs', meta.blobId));
      const blob = b.data();
      if (!blob || !blob.base64) { toast(T('admin.noBlob'), 'error'); return; }
      const url = URL.createObjectURL(new Blob([base64ToBytes(blob.base64)], {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      }));
      const a = document.createElement('a');
      a.href = url;
      a.download = meta.name || 'schedule.docx';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (e) { toast(T('admin.noBlob'), 'error'); }
  }

  /* ------------------------------------------------------------ 事件绑定 */
  function bindEvents() {
    document.querySelectorAll('#view-tabs button').forEach(btn => btn.onclick = () => {
      S.view = btn.dataset.view; updateChrome(); render();
    });
    // 左侧页签：公共 / 个人课表
    document.querySelectorAll('.side-item[data-space]').forEach(btn =>
      btn.onclick = () => setSpace(btn.dataset.space));
    $('nav-help').onclick = () => { toast(T('page.info')); closeSidebar(); };
    $('nav-account').onclick = () => { if (!S.user) openAuth('login'); else openProfile(); closeSidebar(); };
    $('side-toggle').onclick = () => { S.sidebarOpen ? closeSidebar() : openSidebar(); };

    $('lang-zh').onclick = () => switchLang('zh');
    $('lang-ru').onclick = () => switchLang('ru');
    $('btn-login').onclick = () => openAuth('login');
    $('btn-logout').onclick = () => { if (S.firebaseReady) FB.signOut(auth); };
    $('btn-profile').onclick = openProfile;

    ['f-faculty', 'f-group', 'f-teacher', 'f-week', 'f-subgroup'].forEach(id => {
      $(id).onchange = () => {
        collectFilters();
        if (id === 'f-week' && S.filters.week) S.anchor = S.filters.week;
        render();
      };
    });
    $('f-keyword').oninput = () => { collectFilters(); render(); };
    $('f-onlymine').onchange = () => setSpace($('f-onlymine').checked ? 'mine' : 'public');
    $('btn-reset').onclick = () => {
      if (S.space === 'mine') return;
      S.filtersPublic = defaultFilters();
      S.filters = publicFilterClone();
      writeStore('cm.filters', S.filtersPublic);
      if (S.user && S.cloudOK) {
        FB.updateDoc(FB.doc(db, 'users', S.user.uid), { filters: S.filtersPublic }).catch(() => {});
      }
      updateSpaceTabs(); initFilterOptions(); render();
    };
    $('btn-save-filters').onclick = saveFilters;
    $('btn-save-schedule').onclick = saveScheduleToMine;
    $('btn-restore').onclick = openRestore;
    $('detail-star').onclick = toggleStar;
    $('restore-close').onclick = () => hideDlg('dlg-restore');
    $('btn-export').onclick = exportScheduleImage;
    $('btn-print').onclick = () => window.print();

    $('btn-prev').onclick = () => shiftAnchor(-1);
    $('btn-next').onclick = () => shiftAnchor(1);
    $('view-date').onchange = e => {
      if (!e.target.value) return;
      // 手动选到空日期时吸附到最近的有数据日期，避免展示无信息的周/月
      clearWeekFilter();
      S.anchor = snapToDataDate(e.target.value);
      render();
    };

    const adminButtons = {
      'btn-upload': 'upload', 'btn-courses': 'courses', 'btn-translations': 'translations',
      'btn-uploads': 'uploads', 'btn-changelog': 'changelog', 'btn-migrate': 'migrate'
    };
    Object.keys(adminButtons).forEach(id => $(id).onclick = () => openAdmin(adminButtons[id]));

    const localBtn = $('btn-local-admin');
    if (localBtn) localBtn.onclick = () => {
      S.localAdmin = !S.localAdmin;
      writeStore('cm.localAdmin', S.localAdmin);
      showOffline(true);
      updateChrome();
      toast(S.localAdmin ? T('offline.localAdminOn') : T('admin.offline'), 'ok');
    };

    $('auth-submit').onclick = submitAuth;
    $('auth-toggle').onclick = () => openAuth(S.authMode === 'register' ? 'login' : 'register');
    $('auth-forgot').onclick = sendReset;
    $('auth-close').onclick = () => hideDlg('dlg-auth');
    $('auth-password').onkeydown = e => { if (e.key === 'Enter') submitAuth(); };
    $('p-save').onclick = saveProfile;
    $('p-close').onclick = () => hideDlg('dlg-profile');
    $('detail-close').onclick = () => hideDlg('dlg-detail');
    $('e-save').onclick = saveEdit;
    $('e-close').onclick = () => hideDlg('dlg-edit');
    $('admin-close').onclick = () => hideDlg('dlg-admin');

    ['dlg-auth', 'dlg-profile', 'dlg-detail', 'dlg-restore', 'dlg-edit', 'dlg-admin'].forEach(id => {
      $(id).addEventListener('click', e => { if (e.target === $(id)) hideDlg(id); });
    });

    $('view-container').addEventListener('click', e => {
      const act = e.target.closest('[data-act]');
      if (act) { e.stopPropagation(); handleAction(act.dataset.act, act.dataset.id, act); return; }
      const idEl = e.target.closest('[data-id]');
      if (idEl) openDetail(idEl.dataset.id);
    });
    $('detail-body').addEventListener('click', e => {
      const btn = e.target.closest('[data-act]');
      if (btn) handleAction(btn.dataset.act, S.detailId, btn);
    });
    $('restore-body').addEventListener('click', e => {
      const btn = e.target.closest('[data-act]');
      if (btn) handleAction(btn.dataset.act, btn.dataset.id, btn);
    });
    $('admin-body').addEventListener('click', e => {
      const btn = e.target.closest('[data-act]');
      if (btn) { e.preventDefault(); handleAction(btn.dataset.act, btn.dataset.id, btn); }
    });
    $('admin-body').addEventListener('input', e => {
      if (e.target.id === 'admin-search') renderAdminCourses(e.target.value);
    });
    $('admin-body').addEventListener('change', e => {
      if (e.target.id === 'admin-files') handleFiles(e.target.files, 'docx');
      if (e.target.id === 'admin-datajs') handleFiles(e.target.files, 'datajs');
    });
    $('admin-body').addEventListener('dragover', e => {
      if (e.target.closest('#dropzone')) { e.preventDefault(); e.currentTarget.querySelector('#dropzone').classList.add('drag'); }
    });
    $('admin-body').addEventListener('dragleave', e => {
      const dz = $('dropzone'); if (dz) dz.classList.remove('drag');
    });
    $('admin-body').addEventListener('drop', e => {
      const dz = e.target.closest('#dropzone');
      if (!dz) return;
      e.preventDefault(); dz.classList.remove('drag');
      const files = Array.from(e.dataTransfer.files || []);
      const kind = files.some(f => /\.js$/i.test(f.name)) ? 'datajs' : 'docx';
      handleFiles(files, kind);
    });
  }

  function shiftAnchor(dir) {
    clearWeekFilter();
    const dates = dataDates();
    if (!dates.length) { S.anchor = addDays(S.anchor, dir * 7); render(); return; }
    if (S.view === 'day') {
      // 日视图：在有数据的日期之间跳，末尾循环到开头
      const target = dir > 0
        ? (dates.find(d => d > S.anchor) || dates[0])
        : (dates.slice().reverse().find(d => d < S.anchor) || dates[dates.length - 1]);
      S.anchor = target;
    } else {
      // 周/明细视图：只在有数据的教学周之间跳，末尾循环到开头
      const weeks = dataWeeks();
      const curWeek = weekStart(S.anchor);
      const targetWeek = dir > 0
        ? (weeks.find(w => w > curWeek) || weeks[0])
        : (weeks.slice().reverse().find(w => w < curWeek) || weeks[weeks.length - 1]);
      S.anchor = dates.find(d => weekStart(d) === targetWeek) || targetWeek;
    }
    render();
  }

  async function handleAction(act, id, el) {
    switch (act) {
      case 'edit': case 'edit-official':
        hideDlg('dlg-detail'); hideDlg('dlg-admin');
        openEdit({ mode: 'official', id: id });
        break;
      case 'del': case 'del-official':
        if (confirm(T('common.confirm') + '?')) await deleteOfficial(id);
        break;
      case 'note-save': await saveNote(false); break;
      case 'note-del': await saveNote(true); break;
      case 'add-personal':
        hideDlg('dlg-detail'); await addPersonal(id);
        break;
      case 'edit-personal':
        if (!S.user || !S.cloudOK) return needLogin();
        hideDlg('dlg-detail'); openEdit({ mode: 'personal', id: id });
        break;
      case 'hide-personal':
        hideDlg('dlg-detail'); await hidePersonal(id);
        break;
      case 'restore-official':
      case 'restore-pick':
        await restoreOfficial(id);
        // 从恢复列表点按时，刷新列表；从详情点按时关闭详情
        if (act === 'restore-pick') openRestore();
        else hideDlg('dlg-detail');
        break;
      case 'report-error': await reportError(id); break;
      case 'pick-files': { const f = $('admin-files'); if (f) f.click(); break; }
      case 'pick-datajs': { const f = $('admin-datajs'); if (f) f.click(); break; }
      case 'apply-dates': await applyDateOverrides(); break;
      case 'do-publish': await publishPending(); break;
      case 'dl-file': await downloadArchivedFile(el.dataset.id); break;
      case 'cancel-pending': S.pending = null; renderAdminBody(); break;
      case 'do-migrate': doMigrate(); break;
      case 'save-translation': await saveTranslation(el.dataset.ru); break;
      default: break;
    }
  }

  /* ------------------------------------------------------------ 启动 */
  function boot() {
    try {
      if (/[?&]localAdmin=1/.test(window.location.search)) {
        S.localAdmin = true;
        writeStore('cm.localAdmin', true);
      } else if (/[?&]localAdmin=0/.test(window.location.search)) {
        S.localAdmin = false;
        writeStore('cm.localAdmin', false);
      }
    } catch (e) { /* 非浏览器环境 */ }
    S.space = 'public';   // 每次进入先回到公共课表；个人页签需手动切换并登录
    applyI18n();
    bindEvents();
    loadLocalData(false);
    initFirebase().then(() => { if (S.firebaseReady) return loadCloud(); });
    setTimeout(() => {
      if (!S.cloudOK) fallbackLocal(T('admin.offline'));
    }, 16000);
  }

  boot();
})();

