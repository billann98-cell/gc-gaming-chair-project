/* 共用工具：跳脫、日期、進度、驗證、資料遷移
   dashboard.js 與 project.js 共用，必須先於它們載入。 */

const SCHEMA_VERSION = 2;
const TRACK_COLORS = ["orange", "slate", "rust", "olive"];
const STATUSES = ["upcoming", "in-progress", "done"];
const STATUS_LABEL = { upcoming: "待辦", "in-progress": "進行中", done: "已完成" };

/* ---------- 跳脫 ---------- */

// 原本用 textContent → innerHTML，不會轉義引號，任務名稱含 " 會破壞 value="..." 屬性
// （硬體專案很常出現 3" 這種尺寸寫法）。改為明確轉義五個字元，文字與屬性兩種情境都安全。
function escapeHtml(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// 只允許 http/https，擋掉 javascript: 之類的連結
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

// 把任意輸入轉成 ISO。刻意不使用 new Date(str) 當 fallback ——
// 舊版就是因為這個 fallback，"8/15" 被解讀成 2001/8/15，畫面顯示「逾期 9000 多天」。
// 無法確定的格式一律回報為 legacy，交給 UI 提示使用者重填，絕不猜測。
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

function formatDate(d) {
  return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
}

function formatDateShort(d) {
  return `${d.getMonth() + 1}/${d.getDate()}`;
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

/* ---------- 期間 ↔ 日期 ---------- */

// periods 只有部分填日期也要能運作，所以先收集有效的錨點
function datedPeriods(periods) {
  const out = [];
  periods.forEach((p, i) => {
    const d = parseISO(p.date);
    if (d) out.push({ i, date: d });
  });
  return out;
}

// 任務結束期間對應的日期。沒有精確日期時用前後錨點線性推估。
function periodDate(periods, index1) {
  const anchors = datedPeriods(periods);
  if (!anchors.length) return null;
  const i = index1 - 1;
  const exact = anchors.find((a) => a.i === i);
  if (exact) return exact.date;
  if (anchors.length < 2) return null;

  const before = [...anchors].reverse().find((a) => a.i < i);
  const after = anchors.find((a) => a.i > i);
  if (before && after) {
    const span = after.i - before.i;
    const days = dayDiff(after.date, before.date);
    return addDays(before.date, Math.round((days / span) * (i - before.i)));
  }
  // 落在錨點範圍外 → 用平均期距外推
  const first = anchors[0], last = anchors[anchors.length - 1];
  const perPeriod = dayDiff(last.date, first.date) / (last.i - first.i);
  if (!isFinite(perPeriod)) return null;
  const base = i < first.i ? first : last;
  return addDays(base.date, Math.round(perPeriod * (i - base.i)));
}

// D1：今天線在甘特圖上的水平百分比。
// 期間 i（0 起算）的左緣 = i/n，對應該期間的日期。
function todayPosition(periods) {
  const n = periods.length;
  const anchors = datedPeriods(periods);
  if (!n) return { ok: false, reason: "沒有期間" };
  if (!anchors.length) return { ok: false, reason: "尚未填入任何期間日期" };
  if (anchors.length < 2) {
    return { ok: false, reason: "需要至少兩個期間日期才能定位今天" };
  }

  const t = today();
  const first = anchors[0], last = anchors[anchors.length - 1];
  const perPeriod = dayDiff(last.date, first.date) / (last.i - first.i);
  if (!isFinite(perPeriod) || perPeriod <= 0) {
    return { ok: false, reason: "期間日期順序不正確" };
  }

  let posIndex; // 以期間索引（0 起算，可含小數）表示今天的位置
  if (t < first.date) {
    posIndex = first.i + dayDiff(t, first.date) / perPeriod;
  } else if (t > last.date) {
    posIndex = last.i + dayDiff(t, last.date) / perPeriod;
  } else {
    let before = first, after = last;
    for (let k = 0; k < anchors.length - 1; k++) {
      if (t >= anchors[k].date && t <= anchors[k + 1].date) {
        before = anchors[k];
        after = anchors[k + 1];
        break;
      }
    }
    const days = dayDiff(after.date, before.date);
    const frac = days === 0 ? 0 : dayDiff(t, before.date) / days;
    posIndex = before.i + frac * (after.i - before.i);
  }

  const pct = (posIndex / n) * 100;
  return {
    ok: true,
    pct: Math.max(0, Math.min(100, pct)),
    outOfRange: pct < 0 || pct > 100,
    date: t,
    // 今天落在第幾期（1 起算），用於「本期」高亮
    periodIndex: Math.min(n, Math.max(1, Math.floor(posIndex) + 1)),
  };
}

/* ---------- 進度（D2） ---------- */

function taskProgress(task) {
  if (task.status === "done") return 1;
  const subs = task.subtasks || [];
  if (subs.length) return subs.filter((s) => s.done).length / subs.length;
  return task.status === "in-progress" ? 0.5 : 0;
}

function aggregateProgress(tasks) {
  const total = tasks.length;
  if (!total) return { pct: 0, done: 0, total: 0, sum: 0 };
  const sum = tasks.reduce((acc, t) => acc + taskProgress(t), 0);
  return {
    pct: Math.round((sum / total) * 100),
    done: tasks.filter((t) => t.status === "done").length,
    total,
    sum,
  };
}

function allTasks(data) {
  return (data.tracks || []).flatMap((t) => t.tasks || []);
}

/* ---------- 驗證（A3） ---------- */

// 回傳修正後的範圍與問題清單。不直接改動傳入物件，呼叫端決定要不要套用。
function clampTaskRange(task, n) {
  const issues = [];
  let s = Math.round(Number(task.start));
  let e = Math.round(Number(task.end));

  if (!Number.isFinite(s) || s < 1) {
    if (task.start !== 1) issues.push("開始期間無效");
    s = 1;
  }
  if (s > n) {
    issues.push(`開始期間超過最後一期（${n}）`);
    s = n;
  }
  if (!Number.isFinite(e) || e < 1) {
    if (task.end !== s) issues.push("結束期間無效");
    e = s;
  }
  if (e > n) {
    issues.push(`結束期間超過最後一期（${n}）`);
    e = n;
  }
  if (e < s) {
    issues.push("結束期間早於開始期間");
    e = s;
  }
  return { start: s, end: e, issues };
}

function isValidPeriodValue(v, n) {
  const x = Number(v);
  return Number.isInteger(x) && x >= 1 && x <= n;
}

// 儲存前的整份檢查，回傳人看得懂的問題清單
function validateProject(data) {
  const problems = [];
  const n = data.periods.length;
  if (!data.project.name || !data.project.name.trim()) problems.push("專案名稱不可空白");
  if (!n) problems.push("至少需要一個期間");

  data.periods.forEach((p, i) => {
    if (p.dateLegacy) problems.push(`第 ${i + 1} 期的日期「${p.dateLegacy}」格式無法辨識，請重新選擇`);
  });

  data.tracks.forEach((track) => {
    track.tasks.forEach((task) => {
      const r = clampTaskRange(task, n);
      r.issues.forEach((msg) => problems.push(`「${track.label} / ${task.title || "未命名任務"}」${msg}`));
      (task.links || []).forEach((l) => {
        if (l.url && !safeUrl(l.url)) {
          problems.push(`「${task.title || "未命名任務"}」的連結必須是 http:// 或 https:// 開頭`);
        }
      });
    });
  });
  return problems;
}

/* ---------- 資料遷移 ---------- */

function normalizeTask(raw, n) {
  const r = clampTaskRange(raw, n);
  const baseline =
    raw.baseline && Number.isFinite(Number(raw.baseline.start)) && Number.isFinite(Number(raw.baseline.end))
      ? { start: Number(raw.baseline.start), end: Number(raw.baseline.end) }
      : null;
  return {
    title: String(raw.title == null ? "" : raw.title),
    start: r.start,
    end: r.end,
    status: STATUSES.includes(raw.status) ? raw.status : "upcoming",
    owner: String(raw.owner || ""),
    note: String(raw.note || ""),
    links: Array.isArray(raw.links)
      ? raw.links.filter((l) => l && l.url).map((l) => ({ label: String(l.label || l.url), url: String(l.url) }))
      : [],
    baseline,
    subtasks: Array.isArray(raw.subtasks)
      ? raw.subtasks.map((s) => ({ title: String(s.title || ""), done: !!s.done }))
      : [],
  };
}

// 把任何版本的專案 JSON 補齊成 schemaVersion 2 的形狀。
// 舊資料的自由文字日期若無法確定格式，保留在 dateLegacy 並由 UI 提示，不靜默丟棄。
function migrateProject(raw) {
  const data = raw && typeof raw === "object" ? raw : {};
  const out = {
    schemaVersion: SCHEMA_VERSION,
    project: {
      name: String((data.project && data.project.name) || "未命名專案"),
      description: String((data.project && data.project.description) || ""),
    },
    periods: [],
    phaseMarkers: [],
    tracks: [],
  };
  if (data.project && data.project.baselineCapturedAt) {
    out.project.baselineCapturedAt = String(data.project.baselineCapturedAt);
  }

  const periods = Array.isArray(data.periods) && data.periods.length ? data.periods : [{ index: 1, date: "" }];
  out.periods = periods.map((p, i) => {
    const { iso, legacy } = coerceToISO(p && p.date);
    const np = { index: i + 1, date: iso };
    if (legacy) np.dateLegacy = legacy;
    return np;
  });
  const n = out.periods.length;

  out.phaseMarkers = (Array.isArray(data.phaseMarkers) ? data.phaseMarkers : []).map((m) => ({
    label: String((m && m.label) || ""),
    line: Math.max(1, Math.min(n + 1, Math.round(Number(m && m.line)) || 1)),
    highlight: !!(m && m.highlight),
  }));

  out.tracks = (Array.isArray(data.tracks) ? data.tracks : []).map((t, ti) => ({
    key: String((t && t.key) || `track-${ti + 1}`),
    label: String((t && t.label) || `軌道 ${ti + 1}`),
    color: TRACK_COLORS.includes(t && t.color) ? t.color : TRACK_COLORS[ti % TRACK_COLORS.length],
    tasks: (Array.isArray(t && t.tasks) ? t.tasks : []).map((task) => normalizeTask(task, n)),
  }));

  return out;
}

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/* ---------- 提醒（供首頁與 Actions 腳本共用的邏輯） ---------- */

// 每個未完成任務用「結束期間對應的日期」當到期日
function projectReminders(projectMeta, data) {
  const out = [];
  (data.tracks || []).forEach((track) => {
    (track.tasks || []).forEach((task) => {
      if (task.status === "done") return;
      const due = periodDate(data.periods, task.end);
      if (!due) return;
      const days = dayDiff(due, today());
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

/* ---------- Node 匯出 ----------
   這個檔案刻意不使用任何 DOM API，讓 GitHub Actions 的 Node 腳本
   （scripts/check-schedule.js）能 require 同一份邏輯，
   避免網站與定時提醒對「到期日」的算法各走各的。 */

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    SCHEMA_VERSION,
    STATUS_LABEL,
    parseISO,
    toISO,
    coerceToISO,
    today,
    dayDiff,
    formatDate,
    severityFor,
    badgeLabel,
    periodDate,
    taskProgress,
    aggregateProgress,
    allTasks,
    validateProject,
    migrateProject,
    projectReminders,
  };
}
