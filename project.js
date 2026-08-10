const params = new URLSearchParams(window.location.search);
const projectId = params.get("id");
const filePath = `projects/${projectId}.json`;
const DRAFT_KEY = `gc-draft:${projectId}`;

let data = null;        // 目前顯示／編輯中的資料
let snapshot = null;    // 進入編輯模式時的深拷貝，用於「取消編輯」還原（A2）
let editMode = false;
let dirty = false;
let editSha = null;     // 載入時的 blob sha，儲存時帶回去做樂觀鎖（A6）
let showBaseline = false;
let importState = { rows: [], newTracks: [], maxEnd: 1 };

/* ---------- 小工具 ---------- */

function $(id) {
  return document.getElementById(id);
}

function hasBaseline() {
  return allTasks(data).some((t) => t.baseline);
}

function statusOptions(selected) {
  return STATUSES.map(
    (s) => `<option value="${s}" ${s === selected ? "selected" : ""}>${STATUS_LABEL[s]}</option>`
  ).join("");
}

/* ---------- 未儲存狀態與草稿（A2） ---------- */

let draftTimer = null;

function markDirty() {
  dirty = true;
  updateDirtyIndicator();
  clearTimeout(draftTimer);
  draftTimer = setTimeout(saveDraft, 600);
}

function saveDraft() {
  try {
    localStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({ savedAt: new Date().toISOString(), sha: editSha, data })
    );
  } catch (e) {
    /* 容量滿了就算了，不影響主要流程 */
  }
}

function clearDraft() {
  localStorage.removeItem(DRAFT_KEY);
}

function readDraft() {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function updateDirtyIndicator() {
  const btn = $("save-btn");
  if (!btn) return;
  btn.textContent = dirty ? "儲存到 GitHub ●" : "儲存到 GitHub";
  btn.classList.toggle("has-changes", dirty);
}

window.addEventListener("beforeunload", (e) => {
  if (!dirty) return;
  e.preventDefault();
  e.returnValue = "";
});

/* ---------- 提示橫幅 ---------- */

let banners = [];

function setBanner(id, level, html, actions) {
  banners = banners.filter((b) => b.id !== id);
  banners.push({ id, level, html, actions: actions || [] });
  renderBanners();
}

function dropBanner(id) {
  banners = banners.filter((b) => b.id !== id);
  renderBanners();
}

function renderBanners() {
  const slot = $("banner-slot");
  slot.innerHTML = banners
    .map(
      (b, i) => `
      <div class="banner ${b.level}">
        <div class="banner-text">${b.html}</div>
        <div class="banner-actions">
          ${b.actions
            .map((a, j) => `<button class="btn-secondary btn-sm" data-banner="${i}" data-action="${j}">${escapeHtml(a.label)}</button>`)
            .join("")}
        </div>
      </div>`
    )
    .join("");
  slot.querySelectorAll("[data-banner]").forEach((el) =>
    el.addEventListener("click", () => {
      banners[+el.dataset.banner].actions[+el.dataset.action].run();
    })
  );
}

/* ---------- 驗證提示（A3） ---------- */

function refreshValidation() {
  // 只在編輯模式提示，純檢視時不要用紅色橫幅干擾
  if (!editMode) {
    dropBanner("validation");
    return;
  }
  const problems = validateProject(data);
  if (!problems.length) {
    dropBanner("validation");
    $("save-btn").disabled = false;
    return;
  }
  const list = problems.slice(0, 6).map((p) => `<li>${escapeHtml(p)}</li>`).join("");
  const more = problems.length > 6 ? `<li>還有 ${problems.length - 6} 項…</li>` : "";
  setBanner(
    "validation",
    "error",
    `<strong>有 ${problems.length} 個問題必須修正才能儲存：</strong><ul>${list}${more}</ul>`
  );
  $("save-btn").disabled = true;
}

/* ---------- 甘特圖 ---------- */

function renderHeader() {
  document.title = `${data.project.name} · 專案排程`;
  $("project-name").textContent = data.project.name;
  $("project-desc").textContent = data.project.description || "";
  $("project-file-path").textContent = filePath;

  const agg = aggregateProgress(allTasks(data));
  const late = countDelayed();
  $("project-progress").innerHTML = `
    <div class="progress-line">
      <div class="progress-bar" role="img" aria-label="整體完成度 ${agg.pct}%">
        <div class="progress-fill" style="width:${agg.pct}%"></div>
      </div>
      <span class="progress-text">${agg.pct}% ・ ${agg.done}/${agg.total} 項完成</span>
      ${late.behind ? `<span class="delay-chip">${late.behind} 項落後基準線</span>` : ""}
      ${late.ahead ? `<span class="ahead-chip">${late.ahead} 項提前</span>` : ""}
    </div>`;
}

function countDelayed() {
  let behind = 0, ahead = 0;
  allTasks(data).forEach((t) => {
    if (!t.baseline) return;
    if (t.end > t.baseline.end) behind++;
    else if (t.end < t.baseline.end) ahead++;
  });
  return { behind, ahead };
}

// 基準線與現況的差異描述（D4）
function baselineDelta(task) {
  if (!task.baseline) return null;
  const d = task.end - task.baseline.end;
  if (d === 0 && task.start === task.baseline.start) return null;
  const nowDate = periodDate(data.periods, task.end);
  const baseDate = periodDate(data.periods, task.baseline.end);
  const days = nowDate && baseDate ? dayDiff(nowDate, baseDate) : null;
  const sign = d > 0 ? "延後" : d < 0 ? "提前" : "調整";
  const periodPart = d === 0 ? "起始調整" : `${sign} ${Math.abs(d)} 期`;
  const dayPart = days ? `（${days > 0 ? "+" : ""}${days} 天）` : "";
  return { text: periodPart + dayPart, direction: d > 0 ? "behind" : d < 0 ? "ahead" : "shift" };
}

function taskTooltip(track, task) {
  const sd = periodDate(data.periods, task.start);
  const ed = periodDate(data.periods, task.end);
  const lines = [
    `${track.label} / ${task.title}`,
    `期間 ${task.start}~${task.end}${sd && ed ? `（${formatDate(sd)} ~ ${formatDate(ed)}）` : ""}`,
    `狀態：${STATUS_LABEL[task.status]}`,
  ];
  if (task.owner) lines.push(`負責人：${task.owner}`);
  const subs = task.subtasks || [];
  if (subs.length) lines.push(`細項：${subs.filter((s) => s.done).length}/${subs.length}`);
  const bd = baselineDelta(task);
  if (bd) lines.push(`對比基準線：${bd.text}`);
  if (task.note) lines.push(`備註：${task.note}`);
  if ((task.links || []).length) lines.push(`連結：${task.links.length} 個`);
  return lines.join("\n");
}

function renderGantt() {
  const { periods, phaseMarkers, tracks } = data;
  const n = periods.length;
  const tp = todayPosition(periods);

  // 期間標頭
  const periodRow = $("period-row");
  periodRow.style.setProperty("--n", n);
  periodRow.innerHTML = periods
    .map((p, i) => {
      const d = parseISO(p.date);
      const isNow = tp.ok && tp.periodIndex === i + 1;
      const legacy = p.dateLegacy
        ? `<span class="period-date bad" title="格式無法辨識，請重新選擇日期">${escapeHtml(p.dateLegacy)} ⚠</span>`
        : `<span class="period-date">${d ? formatDateShort(d) : ""}</span>`;
      return `<div class="period-cell${isNow ? " current" : ""}">${p.index}${legacy}</div>`;
    })
    .join("");

  // 階段里程碑
  $("marker-row").innerHTML = phaseMarkers
    .map((m, i) => {
      const left = ((m.line - 1) / n) * 100;
      const edge = i === 0 ? "first" : i === phaseMarkers.length - 1 ? "last" : "mid";
      return `<div class="marker ${m.highlight ? "highlight" : "normal"}" data-edge="${edge}" style="left:${left}%">${escapeHtml(m.label)}</div>`;
    })
    .join("");

  // 里程碑虛線 + 今天線（D1）
  const lines = phaseMarkers
    .map((m) => `<div class="marker-line${m.highlight ? " highlight" : ""}" style="left:${((m.line - 1) / n) * 100}%"></div>`)
    .join("");
  const todayLine = tp.ok
    ? `<div class="today-line" style="left:${tp.pct}%"><span class="today-flag">今天 ${formatDateShort(tp.date)}</span></div>`
    : "";
  $("marker-lines").innerHTML = lines + todayLine;
  $("today-note").textContent = tp.ok ? "" : `今天線未顯示：${tp.reason}`;

  // 主體
  const bodyEl = $("gantt-body");
  const labelCol = document.createElement("div");
  labelCol.className = "track-label-col";
  const taskCol = document.createElement("div");
  taskCol.style.gridColumn = "2";

  tracks.forEach((track, ti) => {
    const agg = aggregateProgress(track.tasks);

    const trackBlock = document.createElement("div");
    trackBlock.className = "track-block";
    const title = document.createElement("div");
    title.className = "track-title";
    title.dataset.color = track.color;
    title.innerHTML = `
      <span class="track-name">${escapeHtml(track.label)}</span>
      <span class="track-mini" title="${escapeHtml(track.label)} 完成度 ${agg.pct}%">
        <span class="track-mini-bar"><span style="width:${agg.pct}%"></span></span>
        <span class="track-mini-pct">${agg.pct}%</span>
      </span>`;
    trackBlock.appendChild(title);
    track.tasks.forEach(() => {
      const spacer = document.createElement("div");
      spacer.className = "row-spacer";
      trackBlock.appendChild(spacer);
    });
    labelCol.appendChild(trackBlock);

    const taskRows = document.createElement("div");
    taskRows.className = "task-rows";
    taskRows.style.setProperty("--n", n);
    const headerSpacer = document.createElement("div");
    headerSpacer.className = "row-spacer";
    taskRows.appendChild(headerSpacer);

    track.tasks.forEach((task, tj) => {
      const r = clampTaskRange(task, n); // 防禦性：資料若有問題也要畫在合理位置（A3）
      const row = document.createElement("div");
      row.className = "task-row";
      row.style.setProperty("--n", n);

      // 基準線幽靈條（D4）
      if (showBaseline && task.baseline) {
        const b = clampTaskRange(task.baseline, n);
        if (b.start !== r.start || b.end !== r.end) {
          const ghost = document.createElement("div");
          ghost.className = "baseline-bar";
          ghost.style.gridRow = "1";
          ghost.style.gridColumnStart = String(b.start);
          ghost.style.gridColumnEnd = String(b.end + 1);
          ghost.title = `基準線：期間 ${b.start}~${b.end}`;
          row.appendChild(ghost);
        }
      }

      const bar = document.createElement("div");
      bar.className = "task-bar";
      bar.dataset.color = track.color;
      bar.dataset.status = task.status;
      bar.style.gridRow = "1";
      bar.style.gridColumnStart = String(r.start);
      bar.style.gridColumnEnd = String(r.end + 1);
      bar.title = taskTooltip(track, task); // 補上 tooltip，名稱被截斷也看得到全文

      const subs = task.subtasks || [];
      const prog = Math.round(taskProgress(task) * 100);
      const bd = baselineDelta(task);
      bar.innerHTML = `
        ${prog > 0 && prog < 100 ? `<span class="bar-fill" style="width:${prog}%"></span>` : ""}
        <span class="bar-label">
          ${task.owner ? `<span class="owner-chip" title="負責人：${escapeHtml(task.owner)}">${escapeHtml(task.owner)}</span>` : ""}
          ${escapeHtml(task.title)}
          ${subs.length ? `<span class="subtask-progress">(${subs.filter((s) => s.done).length}/${subs.length})</span>` : ""}
          ${(task.links || []).length ? `<span class="link-chip" title="有 ${task.links.length} 個連結">🔗</span>` : ""}
          ${task.note ? `<span class="note-chip" title="${escapeHtml(task.note)}">📝</span>` : ""}
          ${bd && showBaseline ? `<span class="delta-chip ${bd.direction}">${escapeHtml(bd.text)}</span>` : ""}
        </span>`;

      if (editMode) {
        bar.classList.add("editable");
        const h1 = document.createElement("span");
        h1.className = "bar-handle start";
        h1.dataset.handle = "start";
        const h2 = document.createElement("span");
        h2.className = "bar-handle end";
        h2.dataset.handle = "end";
        bar.appendChild(h1);
        bar.appendChild(h2);
        attachDrag(bar, task, ti, tj, taskRows);
      }

      row.appendChild(bar);
      taskRows.appendChild(row);
    });
    taskCol.appendChild(taskRows);
  });

  bodyEl.innerHTML = "";
  bodyEl.appendChild(labelCol);
  bodyEl.appendChild(taskCol);

  document.querySelector(".legend-baseline").style.display = hasBaseline() && showBaseline ? "flex" : "none";
}

// D1：開頁時把今天捲進視野
function scrollToToday() {
  const tp = todayPosition(data.periods);
  if (!tp.ok) return;
  const scroller = $("gantt-scroll");
  const gantt = scroller.querySelector(".gantt");
  const labelW = 170;
  const x = labelW + ((gantt.scrollWidth - labelW) * tp.pct) / 100;
  scroller.scrollLeft = Math.max(0, x - scroller.clientWidth / 2);
}

/* ---------- 拖拉調整任務（D7） ---------- */

function attachDrag(bar, task, ti, tj, taskRowsEl) {
  bar.addEventListener("pointerdown", (e) => {
    if (!editMode) return;
    e.preventDefault();
    const n = data.periods.length;
    const mode =
      e.target.dataset.handle === "start"
        ? "resize-start"
        : e.target.dataset.handle === "end"
        ? "resize-end"
        : "move";
    const colWidth = taskRowsEl.getBoundingClientRect().width / n;
    if (!colWidth) return;

    const startX = e.clientX;
    const os = task.start, oe = task.end, len = oe - os;
    let ns = os, ne = oe;

    bar.setPointerCapture(e.pointerId);
    bar.classList.add("dragging");

    const hint = document.createElement("span");
    hint.className = "drag-hint";
    bar.appendChild(hint);

    const onMove = (ev) => {
      const d = Math.round((ev.clientX - startX) / colWidth);
      if (mode === "move") {
        ns = Math.min(Math.max(1, os + d), n - len);
        ne = ns + len;
      } else if (mode === "resize-start") {
        ns = Math.min(Math.max(1, os + d), oe);
        ne = oe;
      } else {
        ns = os;
        ne = Math.max(os, Math.min(n, oe + d));
      }
      bar.style.gridColumnStart = String(ns);
      bar.style.gridColumnEnd = String(ne + 1);
      hint.textContent = `${ns}~${ne}`;
    };

    const finish = () => {
      bar.removeEventListener("pointermove", onMove);
      bar.removeEventListener("pointerup", finish);
      bar.removeEventListener("pointercancel", finish);
      bar.classList.remove("dragging");
      hint.remove();
      if (ns !== os || ne !== oe) {
        task.start = ns;
        task.end = ne;
        markDirty();
        refreshView();
        syncRangeInputs(ti, tj);
      }
    };

    bar.addEventListener("pointermove", onMove);
    bar.addEventListener("pointerup", finish);
    bar.addEventListener("pointercancel", finish);
  });
}

// 拖拉後把編輯面板的數字欄位同步過來（不整頁重繪，避免焦點跳掉）
function syncRangeInputs(ti, tj) {
  const s = document.querySelector(`[data-kind='task-start'][data-track='${ti}'][data-task='${tj}']`);
  const e = document.querySelector(`[data-kind='task-end'][data-track='${ti}'][data-task='${tj}']`);
  if (s) s.value = data.tracks[ti].tasks[tj].start;
  if (e) e.value = data.tracks[ti].tasks[tj].end;
}

function refreshView() {
  renderHeader();
  renderGantt();
  refreshValidation();
}

/* ---------- 編輯面板 ---------- */

function fieldError(el, msg) {
  el.classList.toggle("input-error", !!msg);
  if (msg) el.title = msg;
  else el.removeAttribute("title");
  const slot = el.closest(".task-edit-item, .field-inline");
  if (!slot) return;
  let box = slot.querySelector(".field-error");
  if (msg) {
    if (!box) {
      box = document.createElement("div");
      box.className = "field-error";
      slot.appendChild(box);
    }
    box.textContent = msg;
  } else if (box) {
    box.remove();
  }
}

function renderEditPanel() {
  const panel = $("edit-panel");
  if (!editMode) {
    panel.style.display = "none";
    panel.innerHTML = "";
    return;
  }
  panel.style.display = "block";
  const n = data.periods.length;

  const periodsHtml = data.periods
    .map(
      (p, i) => `
      <label class="field-inline">
        Period ${p.index}
        <input type="date" data-kind="period-date" data-index="${i}" value="${escapeHtml(p.date || "")}" />
        ${p.dateLegacy ? `<span class="field-error">原值「${escapeHtml(p.dateLegacy)}」格式無法辨識，請重新選擇</span>` : ""}
      </label>`
    )
    .join("");

  const trackOptions = data.tracks
    .map((t, i) => `<option value="track:${i}">${escapeHtml(t.label)}</option>`)
    .join("");

  const tracksHtml = data.tracks
    .map((track, ti) => {
      const rows = track.tasks
        .map((task, tj) => {
          const subs = task.subtasks || [];
          const doneN = subs.filter((s) => s.done).length;
          const bd = baselineDelta(task);

          const subRows = subs
            .map(
              (s, sj) => `
            <div class="subtask-row">
              <input type="checkbox" data-kind="subtask-done" data-track="${ti}" data-task="${tj}" data-sub="${sj}" ${s.done ? "checked" : ""} />
              <input type="text" data-kind="subtask-title" data-track="${ti}" data-task="${tj}" data-sub="${sj}" value="${escapeHtml(s.title)}" ${s.done ? "disabled" : ""} />
              <button class="btn-remove" data-kind="subtask-remove" data-track="${ti}" data-task="${tj}" data-sub="${sj}">刪除</button>
            </div>`
            )
            .join("");

          const linkRows = (task.links || [])
            .map(
              (l, lj) => `
            <div class="link-row">
              <input type="text" data-kind="link-label" data-track="${ti}" data-task="${tj}" data-link="${lj}" value="${escapeHtml(l.label)}" placeholder="連結名稱" />
              <input type="url" data-kind="link-url" data-track="${ti}" data-task="${tj}" data-link="${lj}" value="${escapeHtml(l.url)}" placeholder="https://" />
              <button class="btn-remove" data-kind="link-remove" data-track="${ti}" data-task="${tj}" data-link="${lj}">刪除</button>
            </div>`
            )
            .join("");

          return `
        <div class="task-edit-item">
          <div class="task-edit-row">
            <input type="text" data-kind="task-title" data-track="${ti}" data-task="${tj}" value="${escapeHtml(task.title)}" placeholder="任務名稱" />
            <input type="text" class="owner-input" data-kind="task-owner" data-track="${ti}" data-task="${tj}" value="${escapeHtml(task.owner || "")}" placeholder="負責人" />
            <input type="number" min="1" max="${n}" data-kind="task-start" data-track="${ti}" data-task="${tj}" value="${task.start}" />
            <span>~</span>
            <input type="number" min="1" max="${n}" data-kind="task-end" data-track="${ti}" data-task="${tj}" value="${task.end}" />
            <select data-kind="task-status" data-track="${ti}" data-task="${tj}">${statusOptions(task.status)}</select>
            <button class="btn-remove" data-kind="task-remove" data-track="${ti}" data-task="${tj}">刪除</button>
          </div>
          ${bd ? `<div class="baseline-note ${bd.direction}">對比基準線：${escapeHtml(bd.text)}（基準 ${task.baseline.start}~${task.baseline.end}）</div>` : ""}
          <details class="subtask-details" ${subs.length || task.note || (task.links || []).length ? "open" : ""}>
            <summary>詳細 ・ 細項 ${doneN}/${subs.length}${task.note ? " ・ 有備註" : ""}${(task.links || []).length ? ` ・ ${task.links.length} 連結` : ""}</summary>
            <div class="subtask-list">
              ${subRows}
              <button class="btn-secondary btn-add-subtask" data-kind="subtask-add" data-track="${ti}" data-task="${tj}">+ 新增細項</button>

              <label class="note-field">備註
                <textarea rows="2" data-kind="task-note" data-track="${ti}" data-task="${tj}" placeholder="風險、決議、待確認事項…">${escapeHtml(task.note || "")}</textarea>
              </label>

              <div class="link-block">
                <div class="link-block-title">相關連結</div>
                ${linkRows}
                <button class="btn-secondary btn-add-subtask" data-kind="link-add" data-track="${ti}" data-task="${tj}">+ 新增連結</button>
              </div>
            </div>
          </details>
        </div>`;
        })
        .join("");

      return `
      <div class="track-edit-block">
        <div class="track-edit-title" data-color="${track.color}">${escapeHtml(track.label)}</div>
        ${rows}
        <button class="btn-secondary btn-add-task" data-kind="task-add" data-track="${ti}">+ 新增任務</button>
      </div>`;
    })
    .join("");

  panel.innerHTML = `
    <section class="edit-section">
      <div class="section-head">
        <h3>期間</h3>
        <div class="period-count">
          共 ${n} 期
          <button class="btn-secondary btn-sm" data-kind="period-remove">−</button>
          <button class="btn-secondary btn-sm" data-kind="period-add">＋</button>
        </div>
      </div>
      <div class="period-edit-grid">${periodsHtml}</div>
      <p class="hint">填入日期後，甘特圖才會顯示今天的位置、也才能算出到期提醒。</p>
    </section>

    <section class="edit-section">
      <h3>批次調整</h3>
      <div class="bulk-row">
        <select data-kind="bulk-scope">
          <option value="all">全部任務</option>
          ${trackOptions}
        </select>
        <select data-kind="bulk-filter">
          <option value="all">所有狀態</option>
          <option value="open">只有未完成</option>
        </select>
        <label class="bulk-num">位移
          <input type="number" value="1" data-kind="bulk-amount" />
          期
        </label>
        <label class="checkbox-line">
          <input type="checkbox" data-kind="bulk-extend" checked /> 不足時自動增加期間
        </label>
        <button class="btn-secondary" data-kind="bulk-apply">套用位移</button>
      </div>
      <p class="hint">正數往後延、負數往前提。例如整條認證軌道要延兩期，選「認證」填 2。</p>
    </section>

    <section class="edit-section">
      <h3>基準線</h3>
      <div class="bulk-row">
        <button class="btn-secondary" data-kind="baseline-set">${hasBaseline() ? "更新為目前排程" : "設定為目前排程"}</button>
        ${hasBaseline() ? `<button class="btn-secondary" data-kind="baseline-clear">清除基準線</button>` : ""}
        ${data.project.baselineCapturedAt ? `<span class="hint inline">基準線建立於 ${escapeHtml(data.project.baselineCapturedAt)}</span>` : ""}
      </div>
      <p class="hint">把目前排程存成基準線之後，之後每次調整都能看出哪些任務延後了幾期／幾天。</p>
    </section>

    <section class="edit-section">
      <div class="section-head">
        <h3>任務</h3>
        <button class="btn-secondary btn-sm" data-kind="import-open">📋 從 Excel 貼上匯入</button>
      </div>
      <p class="hint">在甘特圖上可以直接拖曳長條移動位置，拖兩端可以改長度。</p>
      ${tracksHtml}
    </section>
  `;

  bindEditPanel(panel);
}

function bindEditPanel(panel) {
  const n = () => data.periods.length;
  const T = (e) => data.tracks[+e.target.dataset.track];
  const TK = (e) => T(e).tasks[+e.target.dataset.task];

  // 期間日期
  panel.querySelectorAll("[data-kind='period-date']").forEach((el) =>
    el.addEventListener("change", (e) => {
      const p = data.periods[+e.target.dataset.index];
      p.date = e.target.value || "";
      delete p.dateLegacy;
      markDirty();
      refreshView();
      renderEditPanel();
    })
  );

  panel.querySelector("[data-kind='period-add']").addEventListener("click", () => {
    data.periods.push({ index: data.periods.length + 1, date: "" });
    markDirty();
    refreshView();
    renderEditPanel();
  });

  panel.querySelector("[data-kind='period-remove']").addEventListener("click", () => {
    if (data.periods.length <= 1) {
      alert("至少要保留一個期間。");
      return;
    }
    const last = data.periods.length;
    const affected = allTasks(data).filter((t) => t.end === last || t.start === last).length;
    const markers = data.phaseMarkers.filter((m) => m.line > last).length;
    const msg =
      affected || markers
        ? `刪除第 ${last} 期會影響 ${affected} 個任務與 ${markers} 個里程碑（會被移到前一期）。確定要刪除嗎？`
        : `確定刪除第 ${last} 期？`;
    if (!confirm(msg)) return;
    data.periods.pop();
    const nn = data.periods.length;
    data.tracks.forEach((tr) =>
      tr.tasks.forEach((t) => {
        const r = clampTaskRange(t, nn);
        t.start = r.start;
        t.end = r.end;
        if (t.baseline) {
          const b = clampTaskRange(t.baseline, nn);
          t.baseline.start = b.start;
          t.baseline.end = b.end;
        }
      })
    );
    data.phaseMarkers.forEach((m) => (m.line = Math.min(m.line, nn + 1)));
    markDirty();
    refreshView();
    renderEditPanel();
  });

  // 任務文字欄位
  panel.querySelectorAll("[data-kind='task-title']").forEach((el) =>
    el.addEventListener("input", (e) => {
      TK(e).title = e.target.value;
      markDirty();
      refreshView();
    })
  );
  panel.querySelectorAll("[data-kind='task-owner']").forEach((el) =>
    el.addEventListener("input", (e) => {
      TK(e).owner = e.target.value;
      markDirty();
      refreshView();
    })
  );
  panel.querySelectorAll("[data-kind='task-note']").forEach((el) =>
    el.addEventListener("input", (e) => {
      TK(e).note = e.target.value;
      markDirty();
      refreshView();
    })
  );

  // 期間數字：無效值不寫進資料，只標紅提示；離開欄位時還原（A3）
  ["task-start", "task-end"].forEach((kind) => {
    panel.querySelectorAll(`[data-kind='${kind}']`).forEach((el) => {
      el.addEventListener("input", (e) => {
        const task = TK(e);
        const raw = e.target.value;
        if (!isValidPeriodValue(raw, n())) {
          fieldError(e.target, `請輸入 1 到 ${n()} 之間的整數`);
          return;
        }
        const v = Number(raw);
        const other = kind === "task-start" ? task.end : task.start;
        if (kind === "task-start" && v > other) {
          fieldError(e.target, `開始期間不能大於結束期間（${other}）`);
          return;
        }
        if (kind === "task-end" && v < other) {
          fieldError(e.target, `結束期間不能小於開始期間（${other}）`);
          return;
        }
        fieldError(e.target, "");
        if (kind === "task-start") task.start = v;
        else task.end = v;
        markDirty();
        refreshView();
      });
      el.addEventListener("blur", (e) => {
        const task = TK(e);
        e.target.value = kind === "task-start" ? task.start : task.end;
        fieldError(e.target, "");
      });
    });
  });

  panel.querySelectorAll("[data-kind='task-status']").forEach((el) =>
    el.addEventListener("change", (e) => {
      TK(e).status = e.target.value;
      markDirty();
      refreshView();
      renderEditPanel();
    })
  );

  panel.querySelectorAll("[data-kind='task-remove']").forEach((el) =>
    el.addEventListener("click", (e) => {
      const task = TK(e);
      if (!confirm(`刪除任務「${task.title || "未命名"}」？`)) return;
      T(e).tasks.splice(+e.target.dataset.task, 1);
      markDirty();
      refreshView();
      renderEditPanel();
    })
  );

  panel.querySelectorAll("[data-kind='task-add']").forEach((el) =>
    el.addEventListener("click", (e) => {
      T(e).tasks.push({
        title: "新任務",
        start: 1,
        end: 1,
        status: "upcoming",
        owner: "",
        note: "",
        links: [],
        baseline: null,
        subtasks: [],
      });
      markDirty();
      refreshView();
      renderEditPanel();
    })
  );

  // 細項
  panel.querySelectorAll("[data-kind='subtask-done']").forEach((el) =>
    el.addEventListener("change", (e) => {
      TK(e).subtasks[+e.target.dataset.sub].done = e.target.checked;
      markDirty();
      refreshView();
      renderEditPanel();
    })
  );
  panel.querySelectorAll("[data-kind='subtask-title']").forEach((el) =>
    el.addEventListener("input", (e) => {
      TK(e).subtasks[+e.target.dataset.sub].title = e.target.value;
      markDirty();
    })
  );
  panel.querySelectorAll("[data-kind='subtask-remove']").forEach((el) =>
    el.addEventListener("click", (e) => {
      TK(e).subtasks.splice(+e.target.dataset.sub, 1);
      markDirty();
      refreshView();
      renderEditPanel();
    })
  );
  panel.querySelectorAll("[data-kind='subtask-add']").forEach((el) =>
    el.addEventListener("click", (e) => {
      const task = TK(e);
      if (!task.subtasks) task.subtasks = [];
      task.subtasks.push({ title: "新細項", done: false });
      markDirty();
      refreshView();
      renderEditPanel();
    })
  );

  // 連結
  panel.querySelectorAll("[data-kind='link-label']").forEach((el) =>
    el.addEventListener("input", (e) => {
      TK(e).links[+e.target.dataset.link].label = e.target.value;
      markDirty();
    })
  );
  panel.querySelectorAll("[data-kind='link-url']").forEach((el) =>
    el.addEventListener("input", (e) => {
      const link = TK(e).links[+e.target.dataset.link];
      link.url = e.target.value;
      fieldError(e.target, e.target.value && !safeUrl(e.target.value) ? "必須是 http:// 或 https:// 開頭" : "");
      markDirty();
      refreshView();
    })
  );
  panel.querySelectorAll("[data-kind='link-remove']").forEach((el) =>
    el.addEventListener("click", (e) => {
      TK(e).links.splice(+e.target.dataset.link, 1);
      markDirty();
      refreshView();
      renderEditPanel();
    })
  );
  panel.querySelectorAll("[data-kind='link-add']").forEach((el) =>
    el.addEventListener("click", (e) => {
      const task = TK(e);
      if (!task.links) task.links = [];
      task.links.push({ label: "", url: "" });
      markDirty();
      renderEditPanel();
    })
  );

  // 批次位移（F5）
  panel.querySelector("[data-kind='bulk-apply']").addEventListener("click", () => {
    const scope = panel.querySelector("[data-kind='bulk-scope']").value;
    const filter = panel.querySelector("[data-kind='bulk-filter']").value;
    const amount = Math.round(Number(panel.querySelector("[data-kind='bulk-amount']").value));
    const extend = panel.querySelector("[data-kind='bulk-extend']").checked;
    if (!Number.isFinite(amount) || amount === 0) {
      alert("請填入非零的整數期數。");
      return;
    }
    applyBulkShift(scope, filter, amount, extend);
  });

  // 基準線（D4）
  panel.querySelector("[data-kind='baseline-set']").addEventListener("click", () => {
    if (hasBaseline() && !confirm("這會用目前排程覆蓋現有基準線，確定嗎？")) return;
    allTasks(data).forEach((t) => (t.baseline = { start: t.start, end: t.end }));
    data.project.baselineCapturedAt = toISO(today());
    showBaseline = true;
    markDirty();
    refreshView();
    renderEditPanel();
  });
  const clearBtn = panel.querySelector("[data-kind='baseline-clear']");
  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      if (!confirm("清除所有任務的基準線？")) return;
      allTasks(data).forEach((t) => (t.baseline = null));
      delete data.project.baselineCapturedAt;
      markDirty();
      refreshView();
      renderEditPanel();
    });
  }

  panel.querySelector("[data-kind='import-open']").addEventListener("click", openImport);
}

function applyBulkShift(scope, filter, amount, extend) {
  const targets = [];
  data.tracks.forEach((track, ti) => {
    if (scope !== "all" && scope !== `track:${ti}`) return;
    track.tasks.forEach((task) => {
      if (filter === "open" && task.status === "done") return;
      targets.push(task);
    });
  });
  if (!targets.length) {
    alert("沒有符合條件的任務。");
    return;
  }

  if (amount > 0 && extend) {
    const needed = Math.max(...targets.map((t) => t.end)) + amount;
    while (data.periods.length < needed) {
      data.periods.push({ index: data.periods.length + 1, date: "" });
    }
  }

  const n = data.periods.length;
  let clamped = 0;
  targets.forEach((t) => {
    const len = t.end - t.start;
    let s = t.start + amount;
    if (s < 1) {
      s = 1;
      clamped++;
    }
    if (s + len > n) {
      s = Math.max(1, n - len);
      clamped++;
    }
    t.start = s;
    t.end = Math.min(n, s + len);
  });

  markDirty();
  refreshView();
  renderEditPanel();

  const msg = `已位移 ${targets.length} 個任務${amount > 0 ? `往後 ${amount}` : `往前 ${-amount}`} 期。`;
  if (clamped) {
    setBanner(
      "bulk",
      "warn",
      `${escapeHtml(msg)}其中 <strong>${clamped}</strong> 個任務因為撞到排程邊界被截斷 —— 需要更多期間的話，用「期間」區塊的＋按鈕增加。`,
      [{ label: "知道了", run: () => dropBanner("bulk") }]
    );
  } else {
    setBanner("bulk", "info", escapeHtml(msg), [{ label: "知道了", run: () => dropBanner("bulk") }]);
  }
}

/* ---------- 從 Excel 貼上匯入（F1） ---------- */

const STATUS_ALIASES = {
  待辦: "upcoming", 未開始: "upcoming", upcoming: "upcoming", todo: "upcoming",
  進行中: "in-progress", 執行中: "in-progress", "in-progress": "in-progress", doing: "in-progress",
  已完成: "done", 完成: "done", done: "done", 結案: "done",
};

function parseImportText(text) {
  const lines = text.replace(/\r/g, "").split("\n").filter((l) => l.trim());
  if (!lines.length) return { rows: [], newTracks: [], maxEnd: 1 };

  const delim = lines.some((l) => l.includes("\t")) ? "\t" : ",";
  let order = ["track", "title", "start", "end", "status", "owner", "note"];
  let bodyStart = 0;

  const head = lines[0].split(delim).map((c) => c.trim());
  if (head.some((c) => /軌道|任務|開始|結束|狀態|負責|備註/.test(c))) {
    bodyStart = 1;
    order = head.map((c) => {
      if (/軌道|分類/.test(c)) return "track";
      if (/任務|項目|名稱/.test(c)) return "title";
      if (/開始/.test(c)) return "start";
      if (/結束|完成期/.test(c)) return "end";
      if (/狀態/.test(c)) return "status";
      if (/負責|owner/i.test(c)) return "owner";
      if (/備註|說明|note/i.test(c)) return "note";
      return null;
    });
  }

  const trackByLabel = {};
  data.tracks.forEach((t, i) => (trackByLabel[t.label.trim()] = i));
  const newTracks = [];
  const rows = [];

  for (let li = bodyStart; li < lines.length; li++) {
    const cells = lines[li].split(delim).map((c) => c.trim());
    const rec = { track: "", title: "", start: "", end: "", status: "", owner: "", note: "" };
    order.forEach((key, ci) => {
      if (key) rec[key] = cells[ci] == null ? "" : cells[ci];
    });

    const errors = [];
    if (!rec.title) errors.push("缺少任務名稱");

    let trackIndex = null;
    if (!rec.track) {
      errors.push("缺少軌道");
    } else if (trackByLabel[rec.track] != null) {
      trackIndex = trackByLabel[rec.track];
    } else if (newTracks.includes(rec.track)) {
      trackIndex = null; // 稍後建立
    } else {
      newTracks.push(rec.track);
    }

    const s = Math.round(Number(rec.start));
    const e = Math.round(Number(rec.end));
    const start = Number.isFinite(s) && s >= 1 ? s : 1;
    const end = Number.isFinite(e) && e >= 1 ? e : start;
    if (rec.start && !Number.isFinite(s)) errors.push(`開始期間「${rec.start}」不是數字`);
    if (rec.end && !Number.isFinite(e)) errors.push(`結束期間「${rec.end}」不是數字`);
    if (end < start) errors.push("結束期間早於開始期間");

    const statusKey = rec.status.toLowerCase();
    const status = STATUS_ALIASES[rec.status] || STATUS_ALIASES[statusKey] || "upcoming";
    if (rec.status && !STATUS_ALIASES[rec.status] && !STATUS_ALIASES[statusKey]) {
      errors.push(`狀態「${rec.status}」無法辨識，會當成待辦`);
    }

    rows.push({
      line: li + 1,
      trackLabel: rec.track,
      trackIndex,
      isNewTrack: trackIndex === null && !!rec.track,
      title: rec.title,
      start,
      end: Math.max(start, end),
      status,
      owner: rec.owner,
      note: rec.note,
      errors,
      fatal: errors.some((x) => /缺少|早於/.test(x)),
    });
  }

  const maxEnd = rows.filter((r) => !r.fatal).reduce((m, r) => Math.max(m, r.end), 1);
  return { rows, newTracks, maxEnd };
}

function renderImportPreview() {
  const box = $("import-preview");
  const { rows, newTracks, maxEnd } = importState;
  if (!rows.length) {
    box.innerHTML = "";
    $("import-confirm").disabled = true;
    return;
  }
  const ok = rows.filter((r) => !r.fatal);
  const bad = rows.filter((r) => r.fatal);
  const n = data.periods.length;

  const head = `<tr><th>#</th><th>軌道</th><th>任務</th><th>期間</th><th>狀態</th><th>負責人</th><th>問題</th></tr>`;
  const body = rows
    .slice(0, 30)
    .map(
      (r) => `
      <tr class="${r.fatal ? "row-bad" : r.errors.length ? "row-warn" : ""}">
        <td>${r.line}</td>
        <td>${escapeHtml(r.trackLabel)}${r.isNewTrack ? '<span class="tag-new">新軌道</span>' : ""}</td>
        <td>${escapeHtml(r.title)}</td>
        <td>${r.start}~${r.end}</td>
        <td>${STATUS_LABEL[r.status]}</td>
        <td>${escapeHtml(r.owner)}</td>
        <td>${escapeHtml(r.errors.join("；"))}</td>
      </tr>`
    )
    .join("");

  const notes = [];
  if (newTracks.length) notes.push(`將新增 ${newTracks.length} 條軌道：${newTracks.join("、")}`);
  if (maxEnd > n) {
    notes.push(
      $("import-extend-periods").checked
        ? `期間會從 ${n} 期自動增加到 ${maxEnd} 期`
        : `有任務落在第 ${maxEnd} 期，超過目前 ${n} 期，將被截斷到第 ${n} 期`
    );
  }
  if (rows.length > 30) notes.push(`預覽只顯示前 30 列，實際會匯入 ${ok.length} 列`);

  box.innerHTML = `
    <div class="import-summary">可匯入 <strong>${ok.length}</strong> 列${bad.length ? ` ・ <span class="bad">${bad.length} 列有問題會略過</span>` : ""}</div>
    ${notes.length ? `<ul class="import-notes">${notes.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul>` : ""}
    <div class="import-table-scroll"><table class="import-table">${head}${body}</table></div>`;
  $("import-confirm").disabled = ok.length === 0;
}

function openImport() {
  $("import-modal").style.display = "flex";
  $("import-textarea").value = "";
  importState = { rows: [], newTracks: [], maxEnd: 1 };
  renderImportPreview();
  $("import-textarea").focus();
}

function closeImport() {
  $("import-modal").style.display = "none";
}

function applyImport() {
  const { rows, newTracks, maxEnd } = importState;
  const extend = $("import-extend-periods").checked;

  if (extend && maxEnd > data.periods.length) {
    while (data.periods.length < maxEnd) {
      data.periods.push({ index: data.periods.length + 1, date: "" });
    }
  }

  // 先建立缺少的軌道
  const labelToIndex = {};
  data.tracks.forEach((t, i) => (labelToIndex[t.label.trim()] = i));
  newTracks.forEach((label) => {
    if (labelToIndex[label] != null) return;
    data.tracks.push({
      key: `track-${data.tracks.length + 1}`,
      label,
      color: TRACK_COLORS[data.tracks.length % TRACK_COLORS.length],
      tasks: [],
    });
    labelToIndex[label] = data.tracks.length - 1;
  });

  const n = data.periods.length;
  let added = 0, clamped = 0;
  rows.forEach((r) => {
    if (r.fatal) return;
    const ti = labelToIndex[r.trackLabel.trim()];
    if (ti == null) return;
    const start = Math.min(r.start, n);
    const end = Math.min(r.end, n);
    if (r.end > n) clamped++;
    data.tracks[ti].tasks.push({
      title: r.title,
      start,
      end: Math.max(start, end),
      status: r.status,
      owner: r.owner,
      note: r.note,
      links: [],
      baseline: null,
      subtasks: [],
    });
    added++;
  });

  closeImport();
  markDirty();
  refreshView();
  renderEditPanel();
  setBanner(
    "import",
    clamped ? "warn" : "info",
    `已匯入 <strong>${added}</strong> 個任務${newTracks.length ? `，新增 ${newTracks.length} 條軌道` : ""}${clamped ? `，其中 ${clamped} 個因期間不足被截斷` : ""}。`,
    [{ label: "知道了", run: () => dropBanner("import") }]
  );
}

/* ---------- 編輯模式切換（A2 + A6） ---------- */

async function enterEdit() {
  const btn = $("edit-toggle-btn");
  btn.disabled = true;
  btn.textContent = "檢查最新版本…";
  try {
    // 從 GitHub API 抓最新內容與 sha。Pages 的靜態檔有 CDN 快取延遲，
    // 直接拿它當編輯基礎會覆蓋掉別人剛存的東西。
    const fresh = await ghGetFile(filePath);
    if (fresh.json) {
      const migrated = migrateProject(fresh.json);
      const changed = JSON.stringify(migrated) !== JSON.stringify(data);
      data = migrated;
      editSha = fresh.sha;
      if (changed) {
        setBanner("fresh", "info", "已載入 GitHub 上的最新版本（你剛看到的畫面是快取版本）。", [
          { label: "知道了", run: () => dropBanner("fresh") },
        ]);
      }
    }
  } catch (e) {
    editSha = null;
    setBanner(
      "sha",
      "warn",
      `無法向 GitHub 取得最新版本（${escapeHtml(e.message)}）。仍可編輯，但這次儲存<strong>沒有衝突保護</strong>，可能覆蓋他人變更。`,
      [{ label: "知道了", run: () => dropBanner("sha") }]
    );
  } finally {
    btn.disabled = false;
  }

  snapshot = deepClone(data);
  dirty = false;
  editMode = true;
  btn.textContent = "取消編輯";
  $("save-btn").style.display = "inline-block";
  updateDirtyIndicator();
  refreshView();
  renderEditPanel();
}

function cancelEdit() {
  if (dirty && !confirm("有未儲存的變更，取消編輯會全部丟棄。確定嗎？")) return;
  if (snapshot) data = deepClone(snapshot);
  editMode = false;
  dirty = false;
  clearDraft();
  dropBanner("validation");
  $("edit-toggle-btn").textContent = "✏️ 編輯";
  $("save-btn").style.display = "none";
  refreshView();
  renderEditPanel();
}

$("edit-toggle-btn").addEventListener("click", () => {
  if (editMode) cancelEdit();
  else enterEdit();
});

$("save-btn").addEventListener("click", async () => {
  const problems = validateProject(data);
  if (problems.length) {
    refreshValidation();
    alert(`還有 ${problems.length} 個問題需要修正才能儲存，詳見上方紅色提示。`);
    return;
  }

  // 沒有 sha 就無法更新既有檔案（GitHub 會回 422）。與其讓使用者看到
  // 語意錯誤的「已被他人更新」，直接說明真正原因。
  if (!editSha) {
    setBanner("conflict", "error", "無法取得這個檔案在 GitHub 上的目前版本，因此不能安全地儲存。請重新載入頁面再試。", [
      { label: "重新載入", run: () => window.location.reload() },
    ]);
    return;
  }

  const btn = $("save-btn");
  btn.disabled = true;
  btn.textContent = "儲存中…";
  try {
    const res = await ghPutFile(filePath, data, editSha, `Update project: ${data.project.name}`);
    editSha = res.sha;
    snapshot = deepClone(data);
    dirty = false;
    clearDraft();
    dropBanner("sha");
    btn.textContent = "已儲存 ✓";
    setTimeout(updateDirtyIndicator, 2000);
    loadLastUpdated(true); // 剛剛才 commit，要跳過快取
  } catch (e) {
    if (e.isConflict) {
      setBanner("conflict", "error", escapeHtml(e.message), [
        { label: "重新載入最新版本", run: () => window.location.reload() },
      ]);
    } else {
      alert(`儲存失敗：${e.message}`);
    }
    updateDirtyIndicator();
  } finally {
    btn.disabled = false;
  }
});

/* ---------- 基準線檢視、列印 ---------- */

$("baseline-view-btn").addEventListener("click", () => {
  if (!hasBaseline()) {
    alert("這個專案還沒有基準線。進入「編輯」→「基準線」→「設定為目前排程」就會建立。");
    return;
  }
  showBaseline = !showBaseline;
  $("baseline-view-btn").classList.toggle("active", showBaseline);
  refreshView();
});

$("print-btn").addEventListener("click", () => window.print());

/* ---------- 匯入對話框事件 ---------- */

$("import-close").addEventListener("click", closeImport);
$("import-cancel").addEventListener("click", closeImport);
$("import-confirm").addEventListener("click", applyImport);
$("import-textarea").addEventListener("input", (e) => {
  importState = parseImportText(e.target.value);
  renderImportPreview();
});
$("import-extend-periods").addEventListener("change", renderImportPreview);
$("import-modal").addEventListener("click", (e) => {
  if (e.target.id === "import-modal") closeImport();
});

/* ---------- G2：最後更新者 ---------- */

async function loadLastUpdated(force) {
  const el = $("last-updated");
  el.innerHTML = "";
  try {
    const c = await ghLatestCommit(filePath, force);
    if (!c) return;
    const when = c.date ? new Date(c.date) : null;
    el.innerHTML = `最後更新：${escapeHtml(c.author)} ・ ${
      when ? escapeHtml(formatDate(when) + " " + when.toTimeString().slice(0, 5)) : ""
    } ・ <a href="${escapeHtml(ghFileHistoryUrl(filePath))}" target="_blank" rel="noopener">變更歷史</a>`;
  } catch (e) {
    /* 讀不到就不顯示，不影響主功能 */
  }
}

/* ---------- 啟動 ---------- */

async function init() {
  if (!projectId) {
    document.body.innerHTML = `<p style="padding:40px;">缺少專案 id，請從 <a href="index.html">專案列表</a> 進入。</p>`;
    return;
  }
  let raw;
  try {
    const res = await fetch(`${filePath}?_=${Date.now()}`);
    if (!res.ok) throw new Error(String(res.status));
    raw = await res.json();
  } catch (e) {
    document.body.innerHTML = `<p style="padding:40px;">找不到或無法解析專案「${escapeHtml(projectId)}」（${escapeHtml(e.message)}）。</p>`;
    return;
  }

  data = migrateProject(raw);
  showBaseline = hasBaseline();
  refreshView();
  scrollToToday();
  loadLastUpdated();

  // A2：偵測上次沒存完的草稿
  const draft = readDraft();
  if (draft && draft.data) {
    const when = new Date(draft.savedAt);
    setBanner(
      "draft",
      "warn",
      `偵測到 ${escapeHtml(formatDate(when) + " " + when.toTimeString().slice(0, 5))} 的未儲存草稿。`,
      [
        {
          label: "恢復草稿",
          run: async () => {
            dropBanner("draft");
            await enterEdit();
            data = migrateProject(draft.data);
            dirty = true;
            updateDirtyIndicator();
            refreshView();
            renderEditPanel();
          },
        },
        { label: "丟棄", run: () => { clearDraft(); dropBanner("draft"); } },
      ]
    );
  }
}

init();
