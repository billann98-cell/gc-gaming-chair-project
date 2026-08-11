/* Daily Task：每週任務看板。
   資料一週一檔：daily/<isoYear>-W<week>.json
   與甘特圖專案完全獨立，只共用 utils.js 的日期工具與 xlsx.js 的 Excel 解析。 */

const DAILY_SCHEMA_VERSION = 1;

const DAILY_CATEGORIES = [
  { key: "weekly", label: "每週主題", excel: /^weekly\s*task$/i },
  { key: "daily", label: "每日任務", excel: /^daily\s*task$/i },
  { key: "rush", label: "急件", excel: /^rush\s*task$/i },
  { key: "meeting", label: "會議", excel: /^meeting\s*\/?\s*call$/i },
];

const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri"];
const DAY_HEADERS = ["MON", "TUE", "WED", "THU", "FRI"];
const DAY_LABELS = { mon: "一", tue: "二", wed: "三", thu: "四", fri: "五" };

function dailyPath(isoYear, isoWeek) {
  return `daily/${isoYear}-W${String(isoWeek).padStart(2, "0")}.json`;
}

function emptyWeek(isoYear, isoWeek) {
  return {
    schemaVersion: DAILY_SCHEMA_VERSION,
    week: { isoYear, isoWeek, monday: toISO(mondayOfIsoWeek(isoYear, isoWeek)) },
    backlog: [],
    entries: [],
  };
}

/* ---------- 解析 Excel（Bill Schedule.xlsx 的格式） ---------- */

// 標題裡塞了很多資訊：前綴需求日、後綴到期日、> 後面的備註、(Project) 標記。
// 例：「(07/27)確認Chair Reddit回覆 with Drew (8/11)」
function parseTaskTitle(raw, refDate) {
  let s = String(raw == null ? "" : raw).trim();
  let note = "";

  const gt = s.indexOf(">");
  if (gt >= 0) {
    note = s.slice(gt + 1).trim();
    s = s.slice(0, gt).trim();
  }

  // 前綴需求日：(07/27) 或 7/24:
  let requestDate = "";
  let m = s.match(/^\((\d{1,2})\s*\/\s*(\d{1,2})\)\s*/);
  if (m) {
    requestDate = resolveMonthDay(+m[1], +m[2], refDate);
    s = s.slice(m[0].length);
  } else {
    m = s.match(/^(\d{1,2})\s*\/\s*(\d{1,2})\s*[:：]\s*/);
    if (m) {
      requestDate = resolveMonthDay(+m[1], +m[2], refDate);
      s = s.slice(m[0].length);
    }
  }

  // 後綴到期日：(8/11)
  let due = "";
  m = s.match(/\((\d{1,2})\s*\/\s*(\d{1,2})\)\s*$/);
  if (m) {
    due = resolveMonthDay(+m[1], +m[2], refDate);
    s = s.slice(0, m.index).trim();
  }

  // 檔案裡有 (Project) 也有拼錯的 (Projerct)，兩種都收
  const isProject = /\((project|projerct)\)\s*$/i.test(s);
  if (isProject) s = s.replace(/\((project|projerct)\)\s*$/i, "").trim();

  return { title: s.trim(), requestDate, due, note, isProject };
}

// 「未完成，移至8/ 6完成」→ 記成 moved 並抓出日期
function parseEntryStatus(note, refDate) {
  const m = String(note || "").match(/移至\s*(\d{1,2})\s*\/\s*(\d{1,2})/);
  if (m) return { status: "moved", movedTo: resolveMonthDay(+m[1], +m[2], refDate) };
  if (/未完成/.test(note)) return { status: "moved", movedTo: "" };
  if (/完成|done/i.test(note)) return { status: "done", movedTo: "" };
  return { status: "open", movedTo: "" };
}

// 欄位位置在各週工作表之間會漂移（W31/W32 有 # 欄、W33 換成 Due Date），
// 所以一律用表頭文字定位，不用固定欄號。
function parseWeekSheet(rows, isoWeek, fallbackYear) {
  const headerIdx = (rows || []).findIndex((r) =>
    (r || []).some((c) => /^MON$/i.test(String(c == null ? "" : c).trim()))
  );
  if (headerIdx < 0) return null;

  const header = rows[headerIdx].map((c) => String(c == null ? "" : c).trim());
  const findCol = (re) => header.findIndex((c) => re.test(c));

  const taskCol = findCol(/TASK/i);
  const dueCol = findCol(/due\s*date/i);
  const doneCol = findCol(/V\s*when\s*finish/i);

  const dayCols = {};
  DAY_HEADERS.forEach((h, i) => {
    const ci = header.findIndex((c) => new RegExp(`^${h}$`, "i").test(c));
    if (ci >= 0) dayCols[DAY_KEYS[i]] = ci;
  });
  if (dayCols.mon == null) return null;

  // 分類標籤在 MON 左邊那一欄
  const catCol = dayCols.mon - 1;

  // 先掃一遍所有明確日期，推出這份表屬於哪一年
  const years = {};
  rows.slice(headerIdx + 1).forEach((r) => {
    const v = dueCol >= 0 ? String((r || [])[dueCol] || "").trim() : "";
    if (/^\d+(\.\d+)?$/.test(v)) {
      const iso = excelSerialToISO(v);
      if (iso) years[iso.slice(0, 4)] = (years[iso.slice(0, 4)] || 0) + 1;
    }
  });
  const isoYear = Object.keys(years).length
    ? Number(Object.keys(years).sort((a, b) => years[b] - years[a])[0])
    : fallbackYear;

  const monday = mondayOfIsoWeek(isoYear, isoWeek);
  const week = emptyWeek(isoYear, isoWeek);

  let currentCat = DAILY_CATEGORIES[0].key;
  let bId = 0;
  let eId = 0;

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const cell = (ci) => (ci >= 0 && row[ci] != null ? String(row[ci]).trim() : "");

    // 分類標籤只寫在區塊第一列，之後沿用
    const catRaw = cell(catCol);
    if (catRaw) {
      const hit = DAILY_CATEGORIES.find((c) => c.excel.test(catRaw));
      if (hit) currentCat = hit.key;
    }

    // 左半：backlog
    const taskRaw = cell(taskCol);
    if (taskRaw && !/^#$/.test(taskRaw) && !/^範例$/.test(taskRaw)) {
      const p = parseTaskTitle(taskRaw, monday);
      if (p.title) {
        let due = p.due;
        const dueRaw = cell(dueCol);
        if (dueRaw) {
          // Due Date 欄是權威來源，優先於標題後綴推出來的
          const iso = /^\d+(\.\d+)?$/.test(dueRaw) ? excelSerialToISO(dueRaw) : coerceToISO(dueRaw).iso;
          if (iso) due = iso;
        }
        week.backlog.push({
          id: `b${++bId}`,
          title: p.title,
          requestDate: p.requestDate,
          due,
          note: p.note,
          done: /^v$/i.test(cell(doneCol)),
          priority: null,
          isProject: p.isProject,
          sourceRow: i + 1,
        });
      }
    }

    // 右半：每天的安排
    DAY_KEYS.forEach((day) => {
      const raw = cell(dayCols[day]);
      if (!raw) return;
      const p = parseTaskTitle(raw, monday);
      if (!p.title) return;
      const st = parseEntryStatus(p.note, monday);
      week.entries.push({
        id: `e${++eId}`,
        category: currentCat,
        day,
        title: p.title,
        due: p.due,
        note: p.note,
        status: st.status,
        movedTo: st.movedTo,
        backlogRef: null,
        sourceRow: i + 1,
      });
    });
  }

  // 把當日安排連回 backlog（標題相同者），之後打勾可以兩邊同步
  const byTitle = {};
  week.backlog.forEach((b) => (byTitle[b.title] = b.id));
  week.entries.forEach((e) => {
    if (byTitle[e.title]) e.backlogRef = byTitle[e.title];
  });

  return week;
}

// 回傳這個工作簿裡所有 W** 工作表解析出的週資料
function parseDailyWorkbook(sheets) {
  const out = [];
  const fallbackYear = today().getFullYear();
  Object.keys(sheets).forEach((name) => {
    const m = String(name).trim().match(/^W\s*(\d{1,2})$/i);
    if (!m) return;
    const week = parseWeekSheet(sheets[name], Number(m[1]), fallbackYear);
    if (week) out.push({ sheetName: name, week });
  });
  out.sort((a, b) => a.week.week.isoWeek - b.week.week.isoWeek);
  return out;
}

/* ---------- 主頁看板 ---------- */

let dtWeek = null;      // 目前顯示的週資料
let dtCursor = null;    // { isoYear, isoWeek }
let dtSha = null;       // 這個週檔在 GitHub 上的 sha，儲存時帶回去
let dtDirty = false;
let dtImport = null;    // 匯入預覽用

function dtIsCurrentWeek() {
  const now = isoWeekInfo(today());
  return dtCursor && dtCursor.isoYear === now.isoYear && dtCursor.isoWeek === now.isoWeek;
}

// 優先用 GitHub API 讀（拿得到 sha，也避開 Pages 的 CDN 快取），失敗才退回靜態檔
async function dtLoadWeek(isoYear, isoWeek) {
  const path = dailyPath(isoYear, isoWeek);
  try {
    const res = await ghGetFile(path);
    if (res.missing) return { week: emptyWeek(isoYear, isoWeek), sha: null, exists: false };
    return { week: res.json, sha: res.sha, exists: true };
  } catch (e) {
    try {
      const r = await fetch(`${path}?_=${Date.now()}`);
      if (!r.ok) return { week: emptyWeek(isoYear, isoWeek), sha: null, exists: false };
      return { week: await r.json(), sha: null, exists: true };
    } catch (e2) {
      return { week: emptyWeek(isoYear, isoWeek), sha: null, exists: false };
    }
  }
}

async function dtGoto(isoYear, isoWeek) {
  if (dtDirty && !confirm("有未儲存的變更，切換週次會丟棄。確定嗎？")) return;
  dtCursor = { isoYear, isoWeek };
  const loaded = await dtLoadWeek(isoYear, isoWeek);
  dtWeek = loaded.week;
  dtSha = loaded.sha;
  dtDirty = false;
  renderDailyBoard(loaded.exists);
}

function dtEntryChip(e) {
  const cls = e.status === "done" ? " done" : e.status === "moved" ? " moved" : "";
  const title = [e.title, e.note ? `備註：${e.note}` : "", e.movedTo ? `移至 ${e.movedTo}` : ""]
    .filter(Boolean)
    .join("\n");
  return `
    <label class="dt-chip${cls}" title="${escapeHtml(title)}">
      <input type="checkbox" data-dt-entry="${escapeHtml(e.id)}" ${e.status === "done" ? "checked" : ""} />
      <span class="dt-chip-text">${escapeHtml(e.title)}</span>
      ${e.note ? '<span class="dt-note-dot" aria-hidden="true">•</span>' : ""}
      ${e.status === "moved" ? '<span class="dt-moved">↷</span>' : ""}
    </label>`;
}

function renderDailyBoard(exists) {
  const slot = document.getElementById("daily-slot");
  if (!slot) return;
  if (!dtWeek) {
    slot.innerHTML = "";
    return;
  }

  const monday = parseISO(dtWeek.week.monday) || mondayOfIsoWeek(dtCursor.isoYear, dtCursor.isoWeek);
  const friday = addDays(monday, 4);
  const st = dailyStats(dtWeek);
  const t = today();
  const todayKey = DAY_KEYS[isoDayNum(t)] || null; // 週末時為 null

  const dayHead = DAY_KEYS.map((d, i) => {
    const date = addDays(monday, i);
    const isToday = todayKey === d && dtIsCurrentWeek();
    return `<div class="dg-day${isToday ? " today" : ""}">${DAY_LABELS[d]} ${formatDateShort(date)}</div>`;
  }).join("");

  const rows = DAILY_CATEGORIES.map((cat) => {
    const cells = DAY_KEYS.map((d) => {
      const items = (dtWeek.entries || []).filter((e) => e.category === cat.key && e.day === d);
      const isToday = todayKey === d && dtIsCurrentWeek();
      return `<div class="dg-cell${isToday ? " today" : ""}">${items.map(dtEntryChip).join("")}</div>`;
    }).join("");
    return `<div class="dg-cat" data-cat="${cat.key}">${cat.label}</div>${cells}`;
  }).join("");

  const overdueHtml = st.overdueList.length
    ? `<div class="dt-overdue">
         <strong>逾期未排定 ${st.overdueList.length} 項：</strong>
         ${st.overdueList
           .slice(0, 6)
           .map((b) => `<span class="dt-od-item">${escapeHtml(b.title)}<em>${escapeHtml(b.due)}</em></span>`)
           .join("")}
         ${st.overdueList.length > 6 ? `<span class="dt-od-item">…還有 ${st.overdueList.length - 6} 項</span>` : ""}
       </div>`
    : "";

  slot.innerHTML = `
    <div class="daily-board">
      <div class="daily-head">
        <div class="daily-title">
          <h3>本週任務</h3>
          <span class="daily-week">${dtCursor.isoYear} W${dtCursor.isoWeek} ・ ${formatDateShort(monday)} – ${formatDateShort(friday)}</span>
        </div>
        <div class="daily-actions">
          <div class="dt-nav">
            <button class="btn-secondary btn-sm" data-dt="prev" title="上一週">←</button>
            <button class="btn-secondary btn-sm" data-dt="today"${dtIsCurrentWeek() ? " disabled" : ""}>本週</button>
            <button class="btn-secondary btn-sm" data-dt="next" title="下一週">→</button>
          </div>
          <button class="btn-secondary btn-sm" data-dt="import">📥 匯入 Excel</button>
          <button class="btn-primary btn-sm" data-dt="save"${dtDirty ? "" : " disabled"}>${dtDirty ? "儲存 ●" : "儲存"}</button>
        </div>
      </div>

      ${
        exists
          ? `<div class="daily-stats">
               ${st.overdue ? `<span class="dt-stat bad">逾期 ${st.overdue}</span>` : ""}
               ${st.dueToday ? `<span class="dt-stat soon">今天到期 ${st.dueToday}</span>` : ""}
               <span class="dt-stat">本週安排 ${st.entriesDone}/${st.entriesTotal} 完成</span>
               <span class="dt-stat">清單 ${st.backlogDone}/${st.backlogTotal} 完成</span>
             </div>`
          : ""
      }

      ${
        exists
          ? `<div class="daily-grid-scroll">
               <div class="daily-grid">
                 <div class="dg-corner"></div>
                 ${dayHead}
                 ${rows}
               </div>
             </div>
             ${overdueHtml}`
          : `<div class="daily-empty">
               這一週還沒有資料。點「📥 匯入 Excel」上傳你的每日工作表，或切換到其他週次。
             </div>`
      }
    </div>`;

  slot.querySelectorAll("[data-dt]").forEach((el) =>
    el.addEventListener("click", () => {
      const act = el.dataset.dt;
      if (act === "prev") {
        const p = shiftIsoWeek(dtCursor.isoYear, dtCursor.isoWeek, -1);
        dtGoto(p.isoYear, p.isoWeek);
      } else if (act === "next") {
        const n = shiftIsoWeek(dtCursor.isoYear, dtCursor.isoWeek, 1);
        dtGoto(n.isoYear, n.isoWeek);
      } else if (act === "today") {
        const now = isoWeekInfo(today());
        dtGoto(now.isoYear, now.isoWeek);
      } else if (act === "import") {
        dtOpenImport();
      } else if (act === "save") {
        dtSave();
      }
    })
  );

  // 打勾：安排與清單同步（同一件事不必勾兩次）
  slot.querySelectorAll("[data-dt-entry]").forEach((el) =>
    el.addEventListener("change", (ev) => {
      const entry = dtWeek.entries.find((x) => x.id === ev.target.dataset.dtEntry);
      if (!entry) return;
      entry.status = ev.target.checked ? "done" : "open";
      if (entry.backlogRef) {
        const b = dtWeek.backlog.find((x) => x.id === entry.backlogRef);
        if (b) b.done = ev.target.checked;
      }
      dtDirty = true;
      renderDailyBoard(true);
    })
  );
}

async function dtSave() {
  if (!dtWeek || !dtDirty) return;
  const path = dailyPath(dtCursor.isoYear, dtCursor.isoWeek);
  try {
    const res = await ghPutFile(path, dtWeek, dtSha, `Update daily tasks: ${dtCursor.isoYear} W${dtCursor.isoWeek}`);
    dtSha = res.sha;
    dtDirty = false;
    renderDailyBoard(true);
    setBanner("dt-save", "info", `已儲存 ${escapeHtml(path)}。`, [
      { label: "知道了", run: () => dropBanner("dt-save") },
    ]);
  } catch (e) {
    if (e.isPermission) {
      await dtShowPermissionHelp();
    } else if (e.isConflict) {
      setBanner("dt-save", "error", escapeHtml(e.message), [
        { label: "重新載入", run: () => window.location.reload() },
      ]);
    } else {
      alert(`儲存失敗：${e.message}`);
    }
  }
}

// 403 時直接跑一次診斷，告訴使用者是哪個設定不對，而不是丟原始訊息
async function dtShowPermissionHelp() {
  setBanner("dt-save", "warn", "寫入被拒絕，正在檢查 Token 權限…");
  const diag = await ghDiagnoseToken();
  setBanner("dt-save", "error", ghTokenFixHtml(diag), [
    { label: "知道了", run: () => dropBanner("dt-save") },
  ]);
}

/* ---------- 匯入 ---------- */

function dtOpenImport() {
  document.getElementById("dt-modal").style.display = "flex";
  document.getElementById("dt-file-input").value = "";
  document.getElementById("dt-preview").innerHTML = "";
  document.getElementById("dt-confirm").disabled = true;
  dtImport = null;
}

function dtCloseImport() {
  document.getElementById("dt-modal").style.display = "none";
}

async function dtHandleFile(file) {
  const sheets = await readXlsx(await file.arrayBuffer());
  const parsed = parseDailyWorkbook(sheets);
  dtImport = { fileName: file.name, weeks: parsed, skipped: Object.keys(sheets).filter((n) => !/^W\s*\d{1,2}$/i.test(n.trim())) };

  const box = document.getElementById("dt-preview");
  if (!parsed.length) {
    box.innerHTML = `<div class="import-summary bad">找不到任何名稱像 W33 的工作表。</div>`;
    document.getElementById("dt-confirm").disabled = true;
    return;
  }

  box.innerHTML = `
    <div class="import-summary">將寫入 <strong>${parsed.length}</strong> 個週次檔案</div>
    <ul class="import-notes">
      ${parsed
        .map(
          (p) =>
            `<li><code>${escapeHtml(dailyPath(p.week.week.isoYear, p.week.week.isoWeek))}</code>　${escapeHtml(
              p.sheetName
            )} → ${escapeHtml(p.week.week.monday)} 起　清單 ${p.week.backlog.length} 筆、安排 ${p.week.entries.length} 筆</li>`
        )
        .join("")}
      ${dtImport.skipped.length ? `<li>略過非週次工作表：${dtImport.skipped.map(escapeHtml).join("、")}</li>` : ""}
      <li>同名週次檔案會被<strong>覆寫</strong>。</li>
    </ul>`;
  document.getElementById("dt-confirm").disabled = false;
}

async function dtApplyImport() {
  if (!dtImport || !dtImport.weeks.length) return;
  const btn = document.getElementById("dt-confirm");
  btn.disabled = true;

  const okList = [];
  const failList = [];
  let permissionDenied = false;
  const weeks = dtImport.weeks;

  for (let i = 0; i < weeks.length; i++) {
    const p = weeks[i];
    const path = dailyPath(p.week.week.isoYear, p.week.week.isoWeek);
    btn.textContent = `寫入 ${path}…`;
    try {
      const existing = await ghGetFile(path).catch(() => ({ sha: null }));
      await ghPutFile(path, p.week, existing.sha || null, `Import daily tasks from Excel: ${p.sheetName}`);
      okList.push(path);
      // 連續對同一個 repo 快速寫入容易觸發 GitHub 的次級限流，稍微間隔
      if (i < weeks.length - 1) await sleep(900);
    } catch (e) {
      failList.push(`${path}（${e.message}）`);
      // 權限問題對每個檔案都一樣，不必再試剩下的
      if (e.isPermission) {
        permissionDenied = true;
        break;
      }
    }
  }

  btn.textContent = "確認匯入";
  btn.disabled = false;
  dtCloseImport();

  // 即使中途失敗也要把已寫入的結果講清楚並刷新看板，
  // 否則使用者看不出到底成功了幾筆（之前這裡直接 return，什麼都不顯示）。
  if (okList.length) {
    setBanner(
      "dt-import",
      failList.length ? "warn" : "info",
      `已匯入 ${okList.length} 個週次：${okList.map((p) => `<code>${escapeHtml(p)}</code>`).join("、")}${
        failList.length ? `<br />另有 ${failList.length} 個未寫入：${failList.map(escapeHtml).join("；")}` : ""
      }`,
      [{ label: "知道了", run: () => dropBanner("dt-import") }]
    );
  } else if (failList.length && !permissionDenied) {
    setBanner("dt-import", "error", `匯入失敗：${failList.map(escapeHtml).join("；")}`, [
      { label: "知道了", run: () => dropBanner("dt-import") },
    ]);
  }

  if (permissionDenied) await dtShowPermissionHelp();

  const now = isoWeekInfo(today());
  await dtGoto(now.isoYear, now.isoWeek);
}

function initDailyBoard() {
  document.getElementById("dt-close").addEventListener("click", dtCloseImport);
  document.getElementById("dt-cancel").addEventListener("click", dtCloseImport);
  document.getElementById("dt-confirm").addEventListener("click", dtApplyImport);
  document.getElementById("dt-modal").addEventListener("click", (e) => {
    if (e.target.id === "dt-modal") dtCloseImport();
  });
  document.getElementById("dt-file-input").addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
      await dtHandleFile(file);
    } catch (err) {
      document.getElementById("dt-preview").innerHTML = `<div class="import-summary bad">讀取失敗：${escapeHtml(err.message)}</div>`;
      document.getElementById("dt-confirm").disabled = true;
    }
  });

  window.addEventListener("beforeunload", (e) => {
    if (!dtDirty) return;
    e.preventDefault();
    e.returnValue = "";
  });

  const now = isoWeekInfo(today());
  dtGoto(now.isoYear, now.isoWeek);
}

/* ---------- 統計 ---------- */

function dailyStats(week) {
  const t = today();
  const backlog = week.backlog || [];
  const open = backlog.filter((b) => !b.done && !b.isProject);
  const overdue = open.filter((b) => b.due && parseISO(b.due) && parseISO(b.due) < t);
  const dueToday = open.filter((b) => b.due && b.due === toISO(t));
  const entries = week.entries || [];
  return {
    backlogTotal: backlog.length,
    backlogDone: backlog.filter((b) => b.done).length,
    overdue: overdue.length,
    dueToday: dueToday.length,
    entriesTotal: entries.length,
    entriesDone: entries.filter((e) => e.status === "done").length,
    overdueList: overdue,
  };
}
