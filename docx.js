/* =====================================================================
   docx.js · 浏览器端 Word 课表解析（零第三方依赖）
   ---------------------------------------------------------------------
   用 DecompressionStream('deflate-raw') 直接解 ZIP，取出 word/document.xml，
   再移植 convert.py 的全部解析规则，保证网页上传与本地脚本结果一致。
   浏览器不支持 deflate-raw 时，管理员可改用「导入 data.js」兜底。
   ===================================================================== */
(function (root) {
  'use strict';

  const TIME_RE = /\d{1,2}[:.]\d{2}\s*[-–—]\s*\d{1,2}[:.]\d{2}/;
  const TIME_ALT_RE = /(?<![\d:])\d{1,2}-\d{2}\s*[-–—]?\s*\d{1,2}[:.]\d{2}/;
  const TIME_ALT_PARTS = /^(\d{1,2})-(\d{2})\s*[-–—]?\s*(\d{1,2})[:.](\d{2})/;
  const ROOM_RE = /[аaАA]\.?\s*\d{3,4}[АБабAB]?(?!\d)/;
  const TEACHER_RE = /[А-ЯЁ][а-яё\-]+\s+[А-ЯЁ]\.\s*[А-ЯЁ]\./;
  const SUBGROUP_RE = /Группа\s+([АБ])/i;
  const MODE_RE = /\(\s*(очно-дистанционно|дистанционно|очно)\s*\)/i;
  const MAJOR_RE = /(Инноватика|УП|СА)/;
  const CLASS_NO_RE = /(?<!\d)\d{3}(?!\d)/g;
  const CLASS_NO_ONE = /(?<!\d)\d{3}(?!\d)/;
  const DATE_IN_NAME = /(\d{2})\.(\d{2})\.(\d{4})/;
  const DATE_LINE = /^\d{2}\.\d{2}\.\d{4}$/;
  const DATE_DMY = /(?<!\d)(\d{1,2})[._\-/](\d{1,2})[._\-/](\d{2,4})(?!\d)/;
  const DATE_YMD = /(?<!\d)(\d{4})[._\-/](\d{1,2})[._\-/](\d{1,2})(?!\d)/;
  const DATE_PURE = /^[\d._\-/]{6,12}$/;
  const WEEKDAY_RU = {
    'Понедельник': '周一', 'Вторник': '周二', 'Среда': '周三',
    'Четверг': '周四', 'Пятница': '周五', 'Суббота': '周六',
    'Воскресенье': '周日'
  };
  const WEEKDAY_CN = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  const WEEKDAY_JS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const HEADER_NOISE = new Set(['Расписание занятий', 'Магистратура', '.']);

  function decodeXml(s) {
    return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (all, ent) => {
      if (ent === 'amp') return '&';
      if (ent === 'lt') return '<';
      if (ent === 'gt') return '>';
      if (ent === 'quot') return '"';
      if (ent === 'apos') return "'";
      const n = ent[0] === '#'
        ? (ent[1] === 'x' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10))
        : 0;
      return Number.isFinite(n) && n > 0 ? String.fromCodePoint(n) : all;
    });
  }

  /* --------------------------------------------------------------- ZIP */
  async function inflateRaw(bytes) {
    if (typeof DecompressionStream === 'undefined') throw new Error('NO_DEFLATE');
    let ds;
    try { ds = new DecompressionStream('deflate-raw'); }
    catch (e) { throw new Error('NO_DEFLATE'); }
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    const out = await new Response(stream).arrayBuffer();
    return new Uint8Array(out);
  }

  async function readZipEntry(buffer, wanted) {
    const dv = new DataView(buffer);
    let eocd = -1;
    const from = Math.max(0, buffer.byteLength - 65557);
    for (let i = buffer.byteLength - 22; i >= from; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('不是有效的 .docx（ZIP）文件');
    const count = dv.getUint16(eocd + 10, true);
    let off = dv.getUint32(eocd + 16, true);
    const dec = new TextDecoder('utf-8');
    for (let i = 0; i < count; i++) {
      if (off + 46 > buffer.byteLength || dv.getUint32(off, true) !== 0x02014b50) break;
      const method = dv.getUint16(off + 10, true);
      const compSize = dv.getUint32(off + 20, true);
      const nameLen = dv.getUint16(off + 28, true);
      const extraLen = dv.getUint16(off + 30, true);
      const commentLen = dv.getUint16(off + 32, true);
      const localOff = dv.getUint32(off + 42, true);
      const name = dec.decode(new Uint8Array(buffer, off + 46, nameLen));
      if (name === wanted) {
        const lNameLen = dv.getUint16(localOff + 26, true);
        const lExtraLen = dv.getUint16(localOff + 28, true);
        const start = localOff + 30 + lNameLen + lExtraLen;
        const raw = new Uint8Array(buffer, start, compSize);
        if (method === 0) return raw;
        if (method === 8) return await inflateRaw(raw);
        throw new Error('不支持的 ZIP 压缩方式：' + method);
      }
      off += 46 + nameLen + extraLen + commentLen;
    }
    throw new Error('docx 里找不到 word/document.xml');
  }

  function docxLines(xml) {
    const paras = xml.match(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g) || [];
    const lines = [];
    const token = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br\s*\/>/g;
    for (const p of paras) {
      let s = '', m;
      token.lastIndex = 0;
      while ((m = token.exec(p)) !== null) {
        if (m[1] !== undefined) s += decodeXml(m[1]);
        else if (m[0].indexOf('w:tab') >= 0) s += '\t';
        else s += ' ';
      }
      s = s.trim();
      if (s) lines.push(s);
    }
    return lines;
  }

  /* ------------------------------------------------------- 解析规则移植 */
  function normaliseDate(d, m, y) {
    d = Number(d); m = Number(m); y = Number(y);
    if (y < 100) y += 2000;
    if (!(y >= 2000 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
    const dt = new Date(y, m - 1, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
    return y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
  }

  function findDate(text) {
    if (!text) return null;
    let m = DATE_YMD.exec(text);
    if (m) { const d = normaliseDate(m[3], m[2], m[1]); if (d) return d; }
    m = DATE_DMY.exec(text);
    if (m) { const d = normaliseDate(m[1], m[2], m[3]); if (d) return d; }
    return null;
  }

  function isDateLine(line) {
    const s = String(line).trim();
    return DATE_PURE.test(s) && !!findDate(s);
  }

  function dateFromFilename(name) { return findDate(name); }

  function dateFromLines(lines) {
    const n = Math.min(lines.length, 12);
    for (let i = 0; i < n; i++) if (isDateLine(lines[i])) return findDate(lines[i].trim());
    for (let i = 0; i < n; i++) { const d = findDate(lines[i]); if (d) return d; }
    return null;
  }

  function resolveDate(name, lines, forced) {
    if (forced && /^\d{4}-\d{2}-\d{2}$/.test(forced))
      return { date: forced, note: '已使用手工指定日期 ' + forced + '：' + name };
    const fn = dateFromFilename(name), body = dateFromLines(lines);
    if (!fn && !body)
      return { date: null, note: '文件名和正文都找不到日期，整份文件已跳过：' + name };
    const cands = [];
    if (fn) cands.push({ from: '文件名', date: fn });
    if (body && body !== fn) cands.push({ from: '正文', date: body });
    const head = weekdayFromHeader(lines);
    let pick;
    if (head) {
      const matched = cands.filter(c => computedWeekday(c.date) === head);
      if (!matched.length) return {
        date: cands[0].date,
        note: '日期与文档星期都不匹配（抬头 ' + head + '），暂用' + cands[0].from + '日期 ' + cands[0].date + '：' + name
      };
      pick = matched.find(c => c.from === '文件名') || matched[0];
    } else pick = cands[0];
    if (pick.from === '正文')
      return { date: pick.date, note: '文件名日期与星期不符，已按正文日期校正 ' + (fn || '无') + ' → ' + pick.date + '：' + name };
    if (body && fn !== body)
      return { date: pick.date, note: '正文日期(' + body + ')与文件名(' + fn + ')不一致，星期校验后保留 ' + fn + '：' + name };
    return { date: pick.date, note: '' };
  }

  function weekdayFromHeader(lines) {
    for (const line of lines.slice(0, 8)) {
      const key = line.trim();
      if (Object.prototype.hasOwnProperty.call(WEEKDAY_RU, key)) return WEEKDAY_RU[key];
    }
    return null;
  }

  function computedWeekday(date) {
    const p = date.split('-').map(Number);
    return WEEKDAY_JS[new Date(p[0], p[1] - 1, p[2]).getDay()];
  }

  function isGroupHeader(line) {
    if (TIME_RE.test(line) || TIME_ALT_RE.test(line)) return false;
    if (HEADER_NOISE.has(line) || findDate(line) !== null) return false;
    if (SUBGROUP_RE.test(line)) return false;
    const hasKurs = /курс/i.test(line);
    const hasGr = /(?:гр\.|группа)\s*\d{3}/i.test(line);
    return (hasKurs || hasGr) && CLASS_NO_ONE.test(line);
  }

  function parseGroupHeader(line, source, warnings) {
    const nums = [...new Set(Array.from(line.matchAll(CLASS_NO_RE), m => m[0]))];
    if (!nums.length) {
      warnings.push({ file: source, issue: '班级抬头解析失败', text: line });
      return [];
    }
    const mm = MAJOR_RE.exec(line);
    const major = mm ? mm[1] : '';
    const modeM = MODE_RE.exec(line);
    const mode = modeM ? modeM[1] : '';
    const headerKnr = line.indexOf('КНР') >= 0;
    return nums.map(num => {
      const year = num[0] === '1' ? '1 курс' : '2 курс';
      // КНР 只认班号 102：源文档偶发把 (КНР) 误贴到 101 抬头，按整行判定会造出不存在的班级
      const knr = num === '102' ? '是' : '';
      if (headerKnr && num !== '102') {
        warnings.push({
          file: source,
          issue: 'КНР 标记与班号不符：文档写了 (КНР)，但班号是 ' + num + '（已按班号判定为非中国班）',
          text: line
        });
      }
      let klass = year + ' гр. ' + num + (major ? ' ' + major : '');
      if (knr) klass += ' (КНР)';
      return { '年级': year, '班号': num, '专业': major, 'КНР': knr, '授课形式': mode, '班级': klass.trim() };
    });
  }

  function extractTime(line) {
    let m = TIME_RE.exec(line);
    if (m) {
      const norm = m[0].replace(/\./g, ':').replace(/[–—]/g, '-');
      return [norm, line.slice(0, m.index) + line.slice(m.index + m[0].length)];
    }
    m = TIME_ALT_RE.exec(line);
    if (m) {
      const p = TIME_ALT_PARTS.exec(m[0]);
      if (p) return [p[1] + ':' + p[2] + ' - ' + p[3] + ':' + p[4],
        line.slice(0, m.index) + line.slice(m.index + m[0].length)];
    }
    return [null, null];
  }

  function strip(s) { return s.replace(/^[,\s]+|[,\s]+$/g, ''); }

  function parseCourseLine(line, groups, date, weekday, source) {
    const [timeStr, rest0] = extractTime(line);
    if (!timeStr) return [];
    let rest = rest0;
    const roomM = ROOM_RE.exec(rest);
    const roomRaw = roomM ? roomM[0] : '';
    const room = roomRaw ? roomRaw.replace(/\s+/g, '') : '网课';
    if (roomRaw) rest = rest.replace(roomRaw, '');
    rest = rest.trim();
    const teacherM = TEACHER_RE.exec(rest);
    const teacher = teacherM ? teacherM[0] : '';
    const course = teacher ? strip(rest.replace(teacher, '')) : strip(rest);
    const subM = SUBGROUP_RE.exec(line);
    const subgroup = subM ? 'Группа ' + subM[1].toUpperCase() : '全部';
    const list = groups && groups.length ? groups : [{}];
    return list.map(g => ({
      '日期': date, '星期': weekday,
      '年级': g['年级'] || '', '班号': g['班号'] || '', '专业': g['专业'] || '',
      'КНР': g['КНР'] || '', '授课形式': g['授课形式'] || '', '小组': subgroup,
      '班级': g['班级'] || 'гр.', '课程': course, '教师': teacher,
      '教室': room, '时间': timeStr, '来源文件': source
    }));
  }

  function parseNoClassLine(groups, date, weekday, source) {
    const list = groups && groups.length ? groups : [{}];
    return list.map(g => ({
      '日期': date, '星期': weekday,
      '年级': g['年级'] || '', '班号': g['班号'] || '', '专业': g['专业'] || '',
      'КНР': g['КНР'] || '', '授课形式': g['授课形式'] || '', '小组': '全部',
      '班级': g['班级'] || 'гр.', '课程': 'Нет занятий', '教师': '',
      '教室': '', '时间': '', '来源文件': source
    }));
  }

  /* ------------------------------------------------------------ 对外接口 */
  function parseDocxLines(lines, fileName, date, dateNote) {
    const warnings = [];
    if (dateNote) warnings.push({ file: fileName, issue: dateNote, text: '' });
    const headerWeekday = weekdayFromHeader(lines);
    const calc = computedWeekday(date);
    if (headerWeekday && headerWeekday !== calc) {
      warnings.push({
        file: fileName,
        issue: '日期与文档星期不一致：采用=' + date + '(' + calc + ')，文档写的是 ' + headerWeekday + '（已按文档保留）',
        text: ''
      });
    }
    const weekday = headerWeekday || calc;
    let groups = [];
    const rows = [];
    let skipped = 0;
    for (const line of lines) {
      if (HEADER_NOISE.has(line) || isDateLine(line)) continue;
      if (Object.prototype.hasOwnProperty.call(WEEKDAY_RU, line.trim())) continue;
      if (isGroupHeader(line)) { groups = parseGroupHeader(line, fileName, warnings); continue; }
      if (line.indexOf('Нет занятий') >= 0) {
        rows.push(...parseNoClassLine(groups, date, weekday, fileName));
        continue;
      }
      if (TIME_RE.test(line) || TIME_ALT_RE.test(line)) {
        rows.push(...parseCourseLine(line, groups, date, weekday, fileName));
        continue;
      }
      skipped++;
      warnings.push({ file: fileName, issue: '跳过无法识别的行', text: line.slice(0, 160) });
    }
    return { rows: rows, warnings: warnings, date: date, skipped: skipped };
  }

  async function docxLinesFromBuffer(buffer) {
    const xmlBytes = await readZipEntry(buffer, 'word/document.xml');
    return docxLines(new TextDecoder('utf-8').decode(xmlBytes));
  }

  async function parseDocx(buffer, fileName, forcedDate) {
    const lines = await docxLinesFromBuffer(buffer);
    const r = resolveDate(fileName, lines, forcedDate);
    if (!r.date) return {
      rows: [], date: null, unresolved: true,
      warnings: [{ file: fileName, issue: r.note, text: fileName }]
    };
    return parseDocxLines(lines, fileName, r.date, r.note);
  }

  async function parseAllFiles(files, overrides) {
    overrides = overrides || {};
    const prepared = [];
    for (const f of files) {
      let lines;
      try { lines = await docxLinesFromBuffer(f.buffer); }
      catch (e) {
        prepared.push({ ...f, lines: [], date: null, note: '文件无法解压：' + e.message });
        continue;
      }
      const r = resolveDate(f.name, lines, overrides[f.name]);
      prepared.push({ ...f, lines: lines, date: r.date, note: r.note });
    }
    prepared.sort((a, b) => {
      const da = a.date || '9999-99-99', db = b.date || '9999-99-99';
      return da === db ? a.name.localeCompare(b.name) : da.localeCompare(db);
    });
    const rows = [], warnings = [], summaries = [], unresolved = [];
    for (const f of prepared) {
      if (!f.date) {
        unresolved.push(f.name);
        warnings.push({ file: f.name, issue: f.note, text: f.name });
        summaries.push({ name: f.name, date: null, count: 0, skipped: 0 });
        continue;
      }
      const r = parseDocxLines(f.lines, f.name, f.date, f.note);
      rows.push(...r.rows);
      warnings.push(...r.warnings);
      summaries.push({ name: f.name, date: r.date, count: r.rows.length, skipped: r.skipped || 0 });
    }
    rows.sort((a, b) => a['日期'] === b['日期']
      ? String(a['时间']).localeCompare(String(b['时间']))
      : String(a['日期']).localeCompare(String(b['日期'])));
    return {
      rows: rows, warnings: warnings, summaries: summaries, unresolved: unresolved,
      files: prepared.map(f => ({ name: f.name, buffer: f.buffer, date: f.date }))
    };
  }

  function parseDataJs(text) {
    const i = text.indexOf('['), j = text.lastIndexOf(']');
    if (i < 0 || j <= i) throw new Error('文件里找不到 scheduleData 数组');
    const rows = JSON.parse(text.slice(i, j + 1));
    if (!Array.isArray(rows)) throw new Error('scheduleData 不是数组');
    return rows;
  }

  root.DocxParser = {
    parseDocx: parseDocx,
    parseAllFiles: parseAllFiles,
    parseDataJs: parseDataJs,
    dateFromFilename: dateFromFilename,
    supportsDeflateRaw: function () {
      if (typeof DecompressionStream === 'undefined') return false;
      try { new DecompressionStream('deflate-raw'); return true; } catch (e) { return false; }
    }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
