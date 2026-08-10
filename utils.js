/* 共用工具：跳脫、日期、時間軸、進度、驗證、資料遷移
   dashboard.js 與 project.js 共用，必須先於它們載入。
   刻意不使用任何 DOM API，讓 GitHub Actions 的 Node 腳本能 require 同一份邏輯。 */

const SCHEMA_VERSION = 3;
const TRACK_COLORS = ["orange", "slate", "rust", "olive"];
const STATUSES = ["upcoming", "in-progress", "done"];
const STATUS_LABEL = { upcoming: "待辦", "in-progress": "進行中", done: "已完成" };
const SCALES = ["week", "month"];
const MIGRATION_PERIOD_DAYS = 14; // 舊資料沒有日期時，假設一期兩週

/* ---------- 跳脫 ---------- */

function escapeHtml(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeUrl(url) {
  const s = String(url || "").trim();
  return /^https?:\/\//i.test(s) ? s : "";
}

/* ---------- 日期 ---------- */

const ISO_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;

function pad2(n) {
  return String(n).padStart(2, "0");
}

function parseISO(s) {
  if (!s) return null;
  const m = String(s).trim().match(ISO_RE);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const dt = new Date(y, mo - 1, d);
  // JS 會把 2026-02-31 自動進位成 3/3，要擋掉
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return dt;
}

function toISO(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// 刻意不使用 new Date(str) 當 fallback：那會把 "8/15" 解讀成 2001 年。
// 無法確定的格式一律回報為 legacy，交給呼叫端提示使用者，絕不猜測。
function coerceToISO(raw) {
  const s = String(raw == null ? "" : raw).trim();
  if (!s) return { iso: "", legacy: "" };
  if (ISO_RE.test(s)) {
    const dt = parseISO(s);
    return dt ? { iso: toISO(dt), legacy: "" } : { iso: "", legacy: s };
  }
  const m = s.match(/^(\d{4})[\/.](\d{1,2})[\/.](\d{1,2})$/);
  if (m) {
    const dt = parseISO(`${m[1]}-${pad2(m[2])}-${pad2(m[3])}`);
    if (dt) return { iso: toISO(dt), legacy: "" };
  }
  return { iso: "", legacy: s };
}

function today() {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate());
}

function dayDiff(a, b) {
  return Math.round((a - b) / 86400000);
}

function addDays(d, n) {
  const r = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  r.setDate(r.getDate() + n);
  return r;
}

function addMonths(d, n) {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}

function mondayOf(d) {
  const r = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = r.getDay(); // 0=日
  return addDays(r, dow === 0 ? -6 : 1 - dow);
}

function startOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function endOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0);
}

function formatDate(d) {
  return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
}

function formatDateShort(d) {
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

// 里程碑落在週末很重要，tooltip 裡一併標出星期
function weekdayLabel(d) {
  return `（週${WEEKDAYS[d.getDay()]}）`;
}

function severityFor(days) {
  if (days < 0) return "overdue";
  if (days <= 7) return "soon";
  return "later";
}

function badgeLabel(days) {
  if (days < 0) return `逾期 ${Math.abs(days)} 天`;
  if (days === 0) return "今天到期";
  if (days <= 7) return `${days} 天後到期`;
  return `${days} 天後`;
}

// 工期（含頭含尾）
function taskDays(task) {
  const s = parseISO(task.start), e = parseISO(task.end);
  if (!s || !e) return 0;
  return dayDiff(e, s) + 1;
}

/* ---------- 時間軸 ---------- */

// 專案涵蓋的日期範圍（任務、基準線、里程碑全部納入）
function contentDateRange(data) {
  const dates = [];
  const push = (v) => {
    const d = parseISO(v);
    if (d) dates.push(d.getTime());
  };
  (data.tracks || []).forEach((tr) =>
    (tr.tasks || []).forEach((t) => {
      push(t.start);
      push(t.end);
      if (t.baseline) {
        push(t.baseline.start);
        push(t.baseline.end);
      }
    })
  );
  (data.phaseMarkers || []).forEach((m) => push(m.date));
  if (!dates.length) return null;
  return { min: new Date(Math.min(...dates)), max: new Date(Math.max(...dates)) };
}

// 依刻度把範圍對齊到完整的週或月，並產出欄位。
// 欄寬用「天數比例」而不是等分，因為各月天數不同。
function buildTimeline(data, scale) {
  const useScale = SCALES.includes(scale) ? scale : "week";
  const content = contentDateRange(data);

  // 完全沒有日期時，至少顯示今天前後各一個月，讓畫面不會空白
  const base = content || { min: addDays(today(), -14), max: addDays(today(), 30) };

  const start = useScale === "week" ? mondayOf(base.min) : startOfMonth(base.min);
  const end = useScale === "week" ? addDays(mondayOf(base.max), 6) : endOfMonth(base.max);
  const totalDays = dayDiff(end, start) + 1;

  const columns = [];
  if (useScale === "week") {
    let cur = start;
    while (cur <= end) {
      const colEnd = addDays(cur, 6);
      columns.push({
        start: cur,
        end: colEnd,
        days: 7,
        label: formatDateShort(cur),
        groupKey: `${cur.getFullYear()}-${cur.getMonth()}`,
        groupLabel: `${cur.getFullYear()} 年 ${cur.getMonth() + 1} 月`,
      });
      cur = addDays(cur, 7);
    }
  } else {
    let cur = startOfMonth(start);
    while (cur <= end) {
      const colEnd = endOfMonth(cur);
      columns.push({
        start: cur,
        end: colEnd,
        days: dayDiff(colEnd, cur) + 1,
        label: `${cur.getMonth() + 1} 月`,
        groupKey: String(cur.getFullYear()),
        groupLabel: `${cur.getFullYear()} 年`,
      });
      cur = addMonths(cur, 1);
    }
  }

  // 表頭第一列的群組（週刻度 → 月份；月刻度 → 年）
  const groups = [];
  columns.forEach((c) => {
    const last = groups[groups.length - 1];
    if (last && last.key === c.groupKey) {
      last.days += c.days;
      last.span += 1;
    } else {
      groups.push({ key: c.groupKey, label: c.groupLabel, days: c.days, span: 1 });
    }
  });

  return { scale: useScale, start, end, totalDays, columns, groups, synthetic: !content };
}

// 某個日期在時間軸上的水平百分比（該日的左緣）
function datePct(dateOrIso, tl) {
  const d = dateOrIso instanceof Date ? dateOrIso : parseISO(dateOrIso);
  if (!d) return null;
  return (dayDiff(d, tl.start) / tl.totalDays) * 100;
}

// 任務長條的位置與寬度。end 為含尾，所以寬度要 +1 天。
function taskGeometry(task, tl) {
  const s = parseISO(task.start), e = parseISO(task.end);
  if (!s || !e) return null;
  const left = (dayDiff(s, tl.start) / tl.totalDays) * 100;
  const width = ((dayDiff(e, s) + 1) / tl.totalDays) * 100;
  return { left, width: Math.max(width, 0.4) }; // 給單日任務一個最小可見寬度
}

// 今天線
function todayPosition(tl) {
  const t = today();
  const pct = datePct(t, tl);
  return {
    date: t,
    pct: Math.max(0, Math.min(100, pct)),
    inRange: t >= tl.start && t <= tl.end,
  };
}

/* ---------- 進度 ---------- */

function taskProgress(task) {
  if (task.status === "done") return 1;
  const subs = task.subtasks || [];
  if (subs.length) return subs.filter((s) => s.done).length / subs.length;
  return task.status === "in-progress" ? 0.5 : 0;
}

function aggregateProgress(tasks) {
  const total = tasks.length;
  if (!total) return { pct: 0, done: 0, total: 0 };
  const sum = tasks.reduce((acc, t) => acc + taskProgress(t), 0);
  return {
    pct: Math.round((sum / total) * 100),
    done: tasks.filter((t) => t.status === "done").length,
    total,
  };
}

function allTasks(data) {
  return (data.tracks || []).flatMap((t) => t.tasks || []);
}

/* ---------- 驗證 ---------- */

function validateProject(data) {
  const problems = [];
  if (!data.project.name || !data.project.name.trim()) problems.push("專案名稱不可空白");

  (data.phaseMarkers || []).forEach((m, i) => {
    if (!m.label || !m.label.trim()) problems.push(`第 ${i + 1} 個里程碑沒有名稱`);
    if (!parseISO(m.date)) problems.push(`里程碑「${m.label || i + 1}」需要一個有效日期`);
  });

  (data.tracks || []).forEach((track) => {
    (track.tasks || []).forEach((task) => {
      const name = `${track.label} / ${task.title || "未命名任務"}`;
      const s = parseISO(task.start), e = parseISO(task.end);
      if (!s) problems.push(`「${name}」缺少或格式錯誤的開始日期`);
      if (!e) problems.push(`「${name}」缺少或格式錯誤的結束日期`);
      if (s && e && e < s) problems.push(`「${name}」結束日期早於開始日期`);
      (task.links || []).forEach((l) => {
        if (l.url && !safeUrl(l.url)) {
          problems.push(`「${name}」的連結必須是 http:// 或 https:// 開頭`);
        }
      });
    });
  });
  return problems;
}

/* ---------- 資料遷移 ---------- */

// v1/v2 的 periods[] 是「第幾期 → 日期」的錨點。回傳一個把期序號換算成日期的函式。
// 完全沒有日期可依據時，改以「第 1 期從本週一開始、每期兩週」推算，並標記 synthesized，
// 讓 UI 能明確告知使用者這些日期是推算出來的、需要確認。
function buildPeriodResolver(periods) {
  const anchors = [];
  (periods || []).forEach((p, i) => {
    const d = parseISO(p && p.date);
    if (d) anchors.push({ i, date: d });
  });

  if (!anchors.length) {
    const base = mondayOf(today());
    return {
      synthesized: true,
      dateOf: (index1) => addDays(base, (index1 - 1) * MIGRATION_PERIOD_DAYS),
    };
  }

  if (anchors.length === 1) {
    const a = anchors[0];
    return {
      synthesized: true, // 只有一個錨點，期距仍是假設值
      dateOf: (index1) => addDays(a.date, (index1 - 1 - a.i) * MIGRATION_PERIOD_DAYS),
    };
  }

  const first = anchors[0], last = anchors[anchors.length - 1];
  const perPeriod = dayDiff(last.date, first.date) / (last.i - first.i);
  return {
    synthesized: false,
    dateOf: (index1) => {
      const i = index1 - 1;
      const exact = anchors.find((a) => a.i === i);
      if (exact) return exact.date;
      const before = [...anchors].reverse().find((a) => a.i < i);
      const after = anchors.find((a) => a.i > i);
      if (before && after) {
        const span = after.i - before.i;
        const days = dayDiff(after.date, before.date);
        return addDays(before.date, Math.round((days / span) * (i - before.i)));
      }
      const anchor = i < first.i ? first : last;
      return addDays(anchor.date, Math.round(perPeriod * (i - anchor.i)));
    },
  };
}

function normalizeLinks(raw) {
  return Array.isArray(raw)
    ? raw.filter((l) => l && l.url).map((l) => ({ label: String(l.label || l.url), url: String(l.url) }))
    : [];
}

function normalizeSubtasks(raw) {
  return Array.isArray(raw) ? raw.map((s) => ({ title: String(s.title || ""), done: !!s.done })) : [];
}

function normalizeStatus(s) {
  return STATUSES.includes(s) ? s : "upcoming";
}

// 已經是日期制的任務
function normalizeDateTask(raw) {
  const s = coerceToISO(raw.start);
  const e = coerceToISO(raw.end);
  const start = s.iso;
  const end = e.iso && parseISO(e.iso) >= parseISO(start || e.iso) ? e.iso : start;
  const bl = raw.baseline;
  const baseline =
    bl && coerceToISO(bl.start).iso && coerceToISO(bl.end).iso
      ? { start: coerceToISO(bl.start).iso, end: coerceToISO(bl.end).iso }
      : null;
  return {
    title: String(raw.title == null ? "" : raw.title),
    start,
    end,
    status: normalizeStatus(raw.status),
    owner: String(raw.owner || ""),
    note: String(raw.note || ""),
    links: normalizeLinks(raw.links),
    baseline,
    subtasks: normalizeSubtasks(raw.subtasks),
  };
}

// 期序號制（v1/v2）的任務 → 日期制。
// 期間 N 的日期代表該期的起點，所以任務 start..end 對應
// 「第 start 期的起點」到「第 end+1 期的起點前一天」。
function periodTaskToDates(raw, resolver) {
  const s = Math.max(1, Math.round(Number(raw.start)) || 1);
  const e = Math.max(s, Math.round(Number(raw.end)) || s);
  const startDate = resolver.dateOf(s);
  const endDate = addDays(resolver.dateOf(e + 1), -1);
  const baseline =
    raw.baseline && Number.isFinite(Number(raw.baseline.start))
      ? {
          start: toISO(resolver.dateOf(Math.max(1, Number(raw.baseline.start)))),
          end: toISO(addDays(resolver.dateOf(Math.max(1, Number(raw.baseline.end)) + 1), -1)),
        }
      : null;
  return {
    title: String(raw.title == null ? "" : raw.title),
    start: toISO(startDate),
    end: toISO(endDate),
    status: normalizeStatus(raw.status),
    owner: String(raw.owner || ""),
    note: String(raw.note || ""),
    links: normalizeLinks(raw.links),
    baseline,
    subtasks: normalizeSubtasks(raw.subtasks),
  };
}

// 判斷是否為舊的期序號制：任務的 start 是數字，或還存在 periods 陣列
function looksLikePeriodModel(data) {
  if (Array.isArray(data.periods) && data.periods.length) return true;
  const first = (data.tracks || []).flatMap((t) => t.tasks || [])[0];
  return !!first && typeof first.start === "number";
}

// 把任何版本的專案 JSON 補齊成 schemaVersion 3 的形狀。
// 回傳的物件帶一個不會被儲存的 _migration 註記，供 UI 提示使用者。
function migrateProject(raw) {
  const data = raw && typeof raw === "object" ? raw : {};
  const out = {
    schemaVersion: SCHEMA_VERSION,
    project: {
      name: String((data.project && data.project.name) || "未命名專案"),
      description: String((data.project && data.project.description) || ""),
    },
    phaseMarkers: [],
    tracks: [],
  };
  if (data.project && data.project.baselineCapturedAt) {
    out.project.baselineCapturedAt = String(data.project.baselineCapturedAt);
  }

  const fromPeriods = looksLikePeriodModel(data);
  let resolver = null;
  if (fromPeriods) resolver = buildPeriodResolver(data.periods);

  out.tracks = (Array.isArray(data.tracks) ? data.tracks : []).map((t, ti) => ({
    key: String((t && t.key) || `track-${ti + 1}`),
    label: String((t && t.label) || `軌道 ${ti + 1}`),
    color: TRACK_COLORS.includes(t && t.color) ? t.color : TRACK_COLORS[ti % TRACK_COLORS.length],
    tasks: (Array.isArray(t && t.tasks) ? t.tasks : []).map((task) =>
      fromPeriods ? periodTaskToDates(task, resolver) : normalizeDateTask(task)
    ),
  }));

  out.phaseMarkers = (Array.isArray(data.phaseMarkers) ? data.phaseMarkers : []).map((m) => {
    if (fromPeriods) {
      // 舊的 line 是「第幾條格線」，等於第 line 期的起點
      const line = Math.max(1, Math.round(Number(m && m.line)) || 1);
      return { label: String((m && m.label) || ""), date: toISO(resolver.dateOf(line)), highlight: !!(m && m.highlight) };
    }
    const c = coerceToISO(m && m.date);
    return { label: String((m && m.label) || ""), date: c.iso, highlight: !!(m && m.highlight) };
  });

  if (fromPeriods) {
    Object.defineProperty(out, "_migration", {
      value: { from: "period", synthesized: resolver.synthesized },
      enumerable: false, // 不會被 JSON.stringify 寫進檔案
    });
  }

  return out;
}

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/* ---------- 提醒 ---------- */

// 每個未完成任務直接以結束日期為到期日
function projectReminders(projectMeta, data) {
  const out = [];
  const t0 = today();
  (data.tracks || []).forEach((track) => {
    (track.tasks || []).forEach((task) => {
      if (task.status === "done") return;
      const due = parseISO(task.end);
      if (!due) return;
      const days = dayDiff(due, t0);
      out.push({
        projectId: projectMeta.id,
        projectName: projectMeta.name || data.project.name,
        trackLabel: track.label,
        taskTitle: task.title,
        owner: task.owner || "",
        due,
        days,
        severity: severityFor(days),
      });
    });
  });
  return out;
}

/* ---------- Node 匯出 ---------- */

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    SCHEMA_VERSION,
    STATUS_LABEL,
    SCALES,
    parseISO,
    toISO,
    coerceToISO,
    today,
    dayDiff,
    addDays,
    addMonths,
    mondayOf,
    formatDate,
    formatDateShort,
    weekdayLabel,
    severityFor,
    badgeLabel,
    taskDays,
    contentDateRange,
    buildTimeline,
    datePct,
    taskGeometry,
    todayPosition,
    taskProgress,
    aggregateProgress,
    allTasks,
    validateProject,
    migrateProject,
    deepClone,
    projectReminders,
  };
}
