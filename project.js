const params = new URLSearchParams(window.location.search);
const projectId = params.get("id");
const filePath = `projects/${projectId}.json`;
const DRAFT_KEY = `gc-draft:${projectId}`;
const SCALE_KEY = `gc-scale:${projectId}`;

let data = null;        // 目前顯示／編輯中的資料
let snapshot = null;    // 進入編輯模式時的深拷貝，用於「取消編輯」還原
let editMode = false;
let dirty = false;
let editSha = null;     // 載入時的 blob sha，儲存時帶回去做樂觀鎖
let showBaseline = false;
let timeline = null;    // buildTimeline() 的結果，渲染與拖拉共用
let scale = "week";
let migrationInfo = null;
let importState = { rows: [], newTracks: [] };
let suppressClickUntil = 0; // 拖拉結束後短暫忽略 click，避免被當成點擊跳轉

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

function loadScale() {
  const s = localStorage.getItem(SCALE_KEY);
  return SCALES.includes(s) ? s : "week";
}

/* ---------- 未儲存狀態與草稿 ---------- */

let draftTimer = null;

function markDirty() {
  dirty = true;
  updateDirtyIndicator();
  clearTimeout(draftTimer);
  draftTimer = setTimeout(saveDraft, 600);
}

function saveDraft() {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ savedAt: new Date().toISOString(), sha: editSha, data }));
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
    el.addEventListener("click", () => banners[+el.dataset.banner].actions[+el.dataset.action].run())
  );
}

/* ---------- 驗證提示 ---------- */

function refreshValidation() {
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
  setBanner("validation", "error", `<strong>有 ${problems.length} 個問題必須修正才能儲存：</strong><ul>${list}${more}</ul>`);
  $("save-btn").disabled = true;
}

/* ---------- 標頭 ---------- */

function renderHeader() {
  document.title = `${data.project.name} · 專案排程`;
  $("project-name").textContent = data.project.name;
  $("project-desc").textContent = data.project.description || "";
  $("project-file-path").textContent = filePath;

  const agg = aggregateProgress(allTasks(data));
  const late = countDelayed();
  const range = contentDateRange(data);
  const span = range ? `${formatDate(range.min)} ~ ${formatDate(range.max)}（${dayDiff(range.max, range.min) + 1} 天）` : "";

  $("project-progress").innerHTML = `
    <div class="progress-line">
      <div class="progress-bar" role="img" aria-label="整體完成度 ${agg.pct}%">
        <div class="progress-fill" style="width:${agg.pct}%"></div>
      </div>
      <span class="progress-text">${agg.pct}% ・ ${agg.done}/${agg.total} 項完成</span>
      ${span ? `<span class="span-text">${escapeHtml(span)}</span>` : ""}
      ${late.behind ? `<span class="delay-chip">${late.behind} 項落後基準線</span>` : ""}
      ${late.ahead ? `<span class="ahead-chip">${late.ahead} 項提前</span>` : ""}
    </div>`;

  $("scale-toggle")
    .querySelectorAll("button")
    .forEach((b) => b.classList.toggle("active", b.dataset.scale === scale));
}

function countDelayed() {
  let behind = 0, ahead = 0;
  allTasks(data).forEach((t) => {
    if (!t.baseline) return;
    const e = parseISO(t.end), be = parseISO(t.baseline.end);
    if (!e || !be) return;
    if (e > be) behind++;
    else if (e < be) ahead++;
  });
  return { behind, ahead };
}

// 基準線與現況的差異，直接以天為單位
function baselineDelta(task) {
  if (!task.baseline) return null;
  const e = parseISO(task.end), be = parseISO(task.baseline.end);
  const s = parseISO(task.start), bs = parseISO(task.baseline.start);
  if (!e || !be) return null;
  const d = dayDiff(e, be);
  if (d === 0 && s && bs && dayDiff(s, bs) === 0) return null;
  if (d === 0) return { text: "起始調整", direction: "shift" };
  return {
    text: `${d > 0 ? "延後" : "提前"} ${Math.abs(d)} 天`,
    direction: d > 0 ? "behind" : "ahead",
  };
}

function taskTooltip(track, task) {
  const s = parseISO(task.start), e = parseISO(task.end);
  const lines = [`${track.label} / ${task.title}`];
  if (s && e) lines.push(`${formatDate(s)} ~ ${formatDate(e)}（${taskDays(task)} 天）`);
  else lines.push("⚠ 缺少日期");
  lines.push(`狀態：${STATUS_LABEL[task.status]}`);
  if (task.owner) lines.push(`負責人：${task.owner}`);
  const subs = task.subtasks || [];
  if (subs.length) lines.push(`細項：${subs.filter((x) => x.done).length}/${subs.length}`);
  const bd = baselineDelta(task);
  if (bd) lines.push(`對比基準線：${bd.text}`);
  if (task.note) lines.push(`備註：${task.note}`);
  if ((task.links || []).length) lines.push(`連結：${task.links.length} 個`);
  lines.push("— 點一下可直接跳到這個任務的編輯欄位");
  return lines.join("\n");
}

/* ---------- 甘特圖（日期軸） ---------- */

function pct(n) {
  return `${n}%`;
}

function renderGantt() {
  timeline = buildTimeline(data, scale);
  const tl = timeline;

  $("range-label").textContent = `${formatDateShort(tl.start)} – ${formatDateShort(tl.end)}`;

  // 依欄位數量撐開寬度，讓每一欄都還讀得到標籤（長專案就靠橫向捲動）
  const minCol = tl.scale === "week" ? 54 : 88;
  document.querySelector(".gantt").style.minWidth = `${Math.max(900, 170 + tl.columns.length * minCol)}px`;

  // 表頭第一列：週刻度顯示月份、月刻度顯示年
  $("scale-groups").innerHTML = tl.groups
    .map((g) => `<div class="scale-group" style="width:${pct((g.days / tl.totalDays) * 100)}">${escapeHtml(g.label)}</div>`)
    .join("");

  // 表頭第二列：實際刻度
  const t0 = today();
  $("scale-cols").innerHTML = tl.columns
    .map((c) => {
      const isNow = t0 >= c.start && t0 <= c.end;
      return `<div class="scale-col${isNow ? " current" : ""}" style="width:${pct((c.days / tl.totalDays) * 100)}" title="${escapeHtml(
        formatDate(c.start) + " ~ " + formatDate(c.end)
      )}">${escapeHtml(c.label)}</div>`;
    })
    .join("");

  // 里程碑標籤：依日期定位，靠邊時調整對齊避免被切掉
  $("marker-row").innerHTML = (data.phaseMarkers || [])
    .map((m) => {
      const p = datePct(m.date, tl);
      if (p === null) return "";
      const align = p < 4 ? "start" : p > 96 ? "end" : "mid";
      return `<div class="marker ${m.highlight ? "highlight" : "normal"}" data-align="${align}" style="left:${pct(p)}" title="${escapeHtml(
        m.label + " ・ " + formatDate(parseISO(m.date))
      )}">${escapeHtml(m.label)}</div>`;
    })
    .join("");

  // 里程碑垂直線 + 今天線
  const lines = (data.phaseMarkers || [])
    .map((m) => {
      const p = datePct(m.date, tl);
      return p === null ? "" : `<div class="marker-line${m.highlight ? " highlight" : ""}" style="left:${pct(p)}"></div>`;
    })
    .join("");
  const tp = todayPosition(tl);
  const todayLine = tp.inRange
    ? `<div class="today-line" style="left:${pct(tp.pct)}"><span class="today-flag">今天 ${formatDateShort(tp.date)}</span></div>`
    : "";
  $("marker-lines").innerHTML = lines + todayLine;
  $("today-note").textContent = tp.inRange ? "" : `今天（${formatDate(tp.date)}）不在這個專案的排程範圍內`;

  // 主體
  const bodyEl = $("gantt-body");
  const labelCol = document.createElement("div");
  labelCol.className = "track-label-col";
  const chartCol = document.createElement("div");
  chartCol.className = "chart-col";
  chartCol.style.gridColumn = "2";

  // 欄位分隔線
  const gridLines = document.createElement("div");
  gridLines.className = "col-lines";
  gridLines.innerHTML = tl.columns
    .slice(1)
    .map((c) => `<div class="col-line" style="left:${pct((dayDiff(c.start, tl.start) / tl.totalDays) * 100)}"></div>`)
    .join("");
  chartCol.appendChild(gridLines);

  (data.tracks || []).forEach((track, ti) => {
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

    const rows = document.createElement("div");
    rows.className = "track-rows";
    const headerSpacer = document.createElement("div");
    headerSpacer.className = "row-spacer";
    rows.appendChild(headerSpacer);

    track.tasks.forEach((task, tj) => {
      const row = document.createElement("div");
      row.className = "task-row";

      const geo = taskGeometry(task, tl);
      if (!geo) {
        const bad = document.createElement("div");
        bad.className = "task-bar invalid";
        bad.dataset.color = track.color;
        bad.style.left = "0%";
        bad.title = taskTooltip(track, task);
        bad.innerHTML = `<span class="bar-label"><span class="bar-title">⚠ ${escapeHtml(task.title || "未命名")}（缺少日期）</span></span>`;
        row.appendChild(bad);
        rows.appendChild(row);
        return;
      }

      // 基準線幽靈條
      if (showBaseline && task.baseline) {
        const bgeo = taskGeometry(task.baseline, tl);
        if (bgeo && (bgeo.left !== geo.left || bgeo.width !== geo.width)) {
          const ghost = document.createElement("div");
          ghost.className = "baseline-bar";
          ghost.style.left = pct(bgeo.left);
          ghost.style.width = pct(bgeo.width);
          ghost.title = `基準線：${formatDate(parseISO(task.baseline.start))} ~ ${formatDate(parseISO(task.baseline.end))}`;
          row.appendChild(ghost);
        }
      }

      const bar = document.createElement("div");
      bar.className = "task-bar";
      bar.dataset.color = track.color;
      bar.dataset.status = task.status;
      bar.style.left = pct(geo.left);
      bar.style.width = pct(geo.width);
      bar.title = taskTooltip(track, task);

      const subs = task.subtasks || [];
      const prog = Math.round(taskProgress(task) * 100);
      const bd = baselineDelta(task);
      bar.innerHTML = `
        ${prog > 0 && prog < 100 ? `<span class="bar-fill" style="width:${prog}%"></span>` : ""}
        <span class="bar-label">
          ${task.owner ? `<span class="owner-chip" title="負責人：${escapeHtml(task.owner)}">${escapeHtml(task.owner)}</span>` : ""}
          <span class="bar-title">${escapeHtml(task.title)}</span>
          ${subs.length ? `<span class="subtask-progress">(${subs.filter((s) => s.done).length}/${subs.length})</span>` : ""}
          ${(task.links || []).length ? `<span class="link-chip" title="有 ${task.links.length} 個連結">🔗</span>` : ""}
          ${task.note ? `<span class="note-chip" title="${escapeHtml(task.note)}">📝</span>` : ""}
          ${bd && showBaseline ? `<span class="delta-chip ${bd.direction}">${escapeHtml(bd.text)}</span>` : ""}
        </span>`;

      if (editMode) {
        bar.classList.add("editable");
        ["start", "end"].forEach((which) => {
          const h = document.createElement("span");
          h.className = `bar-handle ${which}`;
          h.dataset.handle = which;
          bar.appendChild(h);
        });
        attachDrag(bar, task, ti, tj, chartCol);
      }
      attachJumpToEditor(bar, ti, tj);

      row.appendChild(bar);
      rows.appendChild(row);
    });
    chartCol.appendChild(rows);
  });

  bodyEl.innerHTML = "";
  bodyEl.appendChild(labelCol);
  bodyEl.appendChild(chartCol);

  placeNarrowBarLabels();
  document.querySelector(".legend-baseline").style.display = hasBaseline() && showBaseline ? "flex" : "none";
}

// 改成日期軸之後，長條寬度等比於真實工期，短任務的長條會很窄，
// 負責人／備註徽章塞不進去就會被裁掉一半。這裡量測一次，
// 放不下的就把整組標籤移到長條右側顯示（一般甘特圖工具的做法）。
function placeNarrowBarLabels() {
  document.querySelectorAll(".task-bar:not(.invalid)").forEach((bar) => {
    const label = bar.querySelector(".bar-label");
    if (!label) return;
    const badgesClipped = label.scrollWidth > label.clientWidth + 1;
    const tooNarrowToRead = bar.clientWidth < 56;
    bar.classList.toggle("label-outside", badgesClipped || tooNarrowToRead);
  });
}

function scrollToToday() {
  if (!timeline) return;
  const tp = todayPosition(timeline);
  if (!tp.inRange) return;
  const scroller = $("gantt-scroll");
  const gantt = scroller.querySelector(".gantt");
  const labelW = 170;
  const x = labelW + ((gantt.scrollWidth - labelW) * tp.pct) / 100;
  scroller.scrollLeft = Math.max(0, x - scroller.clientWidth / 2);
}

function refreshView() {
  renderHeader();
  renderGantt();
  refreshValidation();
}

/* ---------- 點長條直接跳到編輯欄位 ---------- */

// 專案任務一多，要在編輯面板裡翻很久才找到某一項。點長條就直接帶過去。
function attachJumpToEditor(bar, ti, tj) {
  bar.tabIndex = 0;
  bar.setAttribute("role", "button");

  bar.addEventListener("click", (e) => {
    if (e.target.dataset.handle) return; // 拖拉把手不觸發跳轉
    // 拖拉結束後瀏覽器仍會補一個 click，那不是點擊意圖
    if (performance.now() < suppressClickUntil) return;
    jumpToTaskEditor(ti, tj);
  });

  bar.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    jumpToTaskEditor(ti, tj);
  });
}

async function jumpToTaskEditor(ti, tj) {
  if (!editMode) await enterEdit(); // 順便省掉先按「編輯」的步驟

  const item = document.querySelector(`[data-task-item="${ti}-${tj}"]`);
  if (!item) return;

  const details = item.querySelector("details");
  if (details) details.open = true;

  item.scrollIntoView({ behavior: "smooth", block: "center" });

  // 一次只反白一項，並在動畫結束後把 class 清掉，避免愈點愈多殘留
  document.querySelectorAll(".task-edit-item.flash").forEach((el) => el.classList.remove("flash"));
  void item.offsetWidth; // 強制重排，連續點同一項時動畫才會重播
  item.classList.add("flash");
  item.addEventListener("animationend", () => item.classList.remove("flash"), { once: true });

  const titleInput = item.querySelector("[data-kind='task-title']");
  if (titleInput) titleInput.focus({ preventScroll: true });
}

/* ---------- 拖拉調整（以天為單位） ---------- */

function attachDrag(bar, task, ti, tj, chartEl) {
  bar.addEventListener("pointerdown", (e) => {
    if (!editMode) return;
    e.preventDefault();
    const tl = timeline;
    const chartWidth = chartEl.getBoundingClientRect().width;
    if (!chartWidth) return;
    const pxPerDay = chartWidth / tl.totalDays;

    const mode =
      e.target.dataset.handle === "start"
        ? "resize-start"
        : e.target.dataset.handle === "end"
        ? "resize-end"
        : "move";

    const startX = e.clientX;
    const os = parseISO(task.start), oe = parseISO(task.end);
    if (!os || !oe) return;
    let ns = os, ne = oe;

    bar.setPointerCapture(e.pointerId);
    bar.classList.add("dragging");
    const hint = document.createElement("span");
    hint.className = "drag-hint";
    bar.appendChild(hint);

    const paint = () => {
      const left = (dayDiff(ns, tl.start) / tl.totalDays) * 100;
      const width = ((dayDiff(ne, ns) + 1) / tl.totalDays) * 100;
      bar.style.left = pct(left);
      bar.style.width = pct(Math.max(width, 0.4));
      hint.textContent = `${formatDateShort(ns)} – ${formatDateShort(ne)}（${dayDiff(ne, ns) + 1} 天）`;
    };

    const onMove = (ev) => {
      const d = Math.round((ev.clientX - startX) / pxPerDay);
      if (mode === "move") {
        ns = addDays(os, d);
        ne = addDays(oe, d);
      } else if (mode === "resize-start") {
        ns = addDays(os, d);
        if (ns > oe) ns = oe; // 不允許開始超過結束
        ne = oe;
      } else {
        ns = os;
        ne = addDays(oe, d);
        if (ne < os) ne = os;
      }
      paint();
    };

    const finish = () => {
      bar.removeEventListener("pointermove", onMove);
      bar.removeEventListener("pointerup", finish);
      bar.removeEventListener("pointercancel", finish);
      bar.classList.remove("dragging");
      hint.remove();
      if (dayDiff(ns, os) !== 0 || dayDiff(ne, oe) !== 0) {
        // 用時間戳而不是把旗標存在長條上：refreshView() 會整段重建 DOM，
        // 存在元素上的旗標會跟著元素一起消失。
        suppressClickUntil = performance.now() + 300;
        task.start = toISO(ns);
        task.end = toISO(ne);
        markDirty();
        refreshView();
        syncDateInputs(ti, tj);
      }
    };

    bar.addEventListener("pointermove", onMove);
    bar.addEventListener("pointerup", finish);
    bar.addEventListener("pointercancel", finish);
  });
}

// 拖拉後同步編輯面板的日期欄位，不整頁重繪以免焦點跳掉
function syncDateInputs(ti, tj) {
  const t = data.tracks[ti].tasks[tj];
  const s = document.querySelector(`[data-kind='task-start'][data-track='${ti}'][data-task='${tj}']`);
  const e = document.querySelector(`[data-kind='task-end'][data-track='${ti}'][data-task='${tj}']`);
  if (s) s.value = t.start;
  if (e) e.value = t.end;
  const d = document.querySelector(`[data-days='${ti}-${tj}']`);
  if (d) d.textContent = `${taskDays(t)} 天`;
}

/* ---------- 編輯面板 ---------- */

function fieldError(el, msg) {
  el.classList.toggle("input-error", !!msg);
  if (msg) el.title = msg;
  else el.removeAttribute("title");
  const slot = el.closest(".task-edit-item, .marker-row-edit");
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

  const markersHtml = (data.phaseMarkers || [])
    .map(
      (m, mi) => `
      <div class="marker-row-edit">
        <input type="text" data-kind="marker-label" data-marker="${mi}" value="${escapeHtml(m.label)}" placeholder="里程碑名稱" />
        <input type="date" data-kind="marker-date" data-marker="${mi}" value="${escapeHtml(m.date || "")}" />
        <label class="checkbox-line">
          <input type="checkbox" data-kind="marker-highlight" data-marker="${mi}" ${m.highlight ? "checked" : ""} /> 強調
        </label>
        <button class="btn-remove" data-kind="marker-remove" data-marker="${mi}">刪除</button>
      </div>`
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
        <div class="task-edit-item" data-task-item="${ti}-${tj}">
          <div class="task-edit-row">
            <input type="text" data-kind="task-title" data-track="${ti}" data-task="${tj}" value="${escapeHtml(task.title)}" placeholder="任務名稱" />
            <input type="text" class="owner-input" data-kind="task-owner" data-track="${ti}" data-task="${tj}" value="${escapeHtml(task.owner || "")}" placeholder="負責人" />
            <input type="date" data-kind="task-start" data-track="${ti}" data-task="${tj}" value="${escapeHtml(task.start || "")}" />
            <span>~</span>
            <input type="date" data-kind="task-end" data-track="${ti}" data-task="${tj}" value="${escapeHtml(task.end || "")}" />
            <span class="days-badge" data-days="${ti}-${tj}">${taskDays(task)} 天</span>
            <select data-kind="task-status" data-track="${ti}" data-task="${tj}">${statusOptions(task.status)}</select>
            <button class="btn-remove" data-kind="task-remove" data-track="${ti}" data-task="${tj}">刪除</button>
          </div>
          ${bd ? `<div class="baseline-note ${bd.direction}">對比基準線：${escapeHtml(bd.text)}（基準 ${escapeHtml(task.baseline.start)} ~ ${escapeHtml(task.baseline.end)}）</div>` : ""}
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
        <h3>階段里程碑</h3>
        <button class="btn-secondary btn-sm" data-kind="marker-add">＋ 新增里程碑</button>
      </div>
      <div class="marker-edit-list">${markersHtml || '<p class="hint">還沒有里程碑。</p>'}</div>
      <p class="hint">每個里程碑綁一個實際日期，垂直線會畫在時間軸的對應位置。</p>
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
        </label>
        <select data-kind="bulk-unit">
          <option value="week">週</option>
          <option value="day">天</option>
        </select>
        <label class="checkbox-line">
          <input type="checkbox" data-kind="bulk-markers" /> 里程碑一起位移
        </label>
        <button class="btn-secondary" data-kind="bulk-apply">套用位移</button>
      </div>
      <p class="hint">正數往後延、負數往前提。例如整條認證軌道要延兩週，選「認證」填 2、單位選週。</p>
    </section>

    <section class="edit-section">
      <h3>基準線</h3>
      <div class="bulk-row">
        <button class="btn-secondary" data-kind="baseline-set">${hasBaseline() ? "更新為目前排程" : "設定為目前排程"}</button>
        ${hasBaseline() ? `<button class="btn-secondary" data-kind="baseline-clear">清除基準線</button>` : ""}
        ${data.project.baselineCapturedAt ? `<span class="hint inline">基準線建立於 ${escapeHtml(data.project.baselineCapturedAt)}</span>` : ""}
      </div>
      <p class="hint">存成基準線之後，每次調整都能看出各任務延後或提前幾天。</p>
    </section>

    <section class="edit-section">
      <div class="section-head">
        <h3>任務</h3>
        <button class="btn-secondary btn-sm" data-kind="import-open">📋 從 Excel 貼上匯入</button>
      </div>
      <p class="hint">在甘特圖上可以直接拖曳長條移動日期，拖兩端可以改工期，以天為單位。</p>
      ${tracksHtml}
    </section>
  `;

  bindEditPanel(panel);
}

function bindEditPanel(panel) {
  const T = (e) => data.tracks[+e.target.dataset.track];
  const TK = (e) => T(e).tasks[+e.target.dataset.task];
  const M = (e) => data.phaseMarkers[+e.target.dataset.marker];

  /* 里程碑 */
  panel.querySelectorAll("[data-kind='marker-label']").forEach((el) =>
    el.addEventListener("input", (e) => {
      M(e).label = e.target.value;
      markDirty();
      refreshView();
    })
  );
  panel.querySelectorAll("[data-kind='marker-date']").forEach((el) =>
    el.addEventListener("change", (e) => {
      M(e).date = e.target.value || "";
      markDirty();
      refreshView();
    })
  );
  panel.querySelectorAll("[data-kind='marker-highlight']").forEach((el) =>
    el.addEventListener("change", (e) => {
      M(e).highlight = e.target.checked;
      markDirty();
      refreshView();
    })
  );
  panel.querySelectorAll("[data-kind='marker-remove']").forEach((el) =>
    el.addEventListener("click", (e) => {
      data.phaseMarkers.splice(+e.target.dataset.marker, 1);
      markDirty();
      refreshView();
      renderEditPanel();
    })
  );
  panel.querySelector("[data-kind='marker-add']").addEventListener("click", () => {
    const range = contentDateRange(data);
    data.phaseMarkers.push({ label: "新里程碑", date: toISO(range ? range.min : today()), highlight: false });
    markDirty();
    refreshView();
    renderEditPanel();
  });

  /* 任務文字欄位 */
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

  /* 日期：結束早於開始就擋下並提示，不寫進資料 */
  ["task-start", "task-end"].forEach((kind) => {
    panel.querySelectorAll(`[data-kind='${kind}']`).forEach((el) => {
      el.addEventListener("change", (e) => {
        const task = TK(e);
        const v = e.target.value;
        if (!v) {
          fieldError(e.target, "日期不可空白");
          return;
        }
        const s = kind === "task-start" ? parseISO(v) : parseISO(task.start);
        const en = kind === "task-end" ? parseISO(v) : parseISO(task.end);
        if (s && en && en < s) {
          fieldError(e.target, "結束日期不能早於開始日期");
          e.target.value = kind === "task-start" ? task.start : task.end;
          return;
        }
        fieldError(e.target, "");
        if (kind === "task-start") task.start = v;
        else task.end = v;
        markDirty();
        refreshView();
        syncDateInputs(+e.target.dataset.track, +e.target.dataset.task);
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
      const range = contentDateRange(data);
      const base = range ? range.min : today();
      T(e).tasks.push({
        title: "新任務",
        start: toISO(base),
        end: toISO(addDays(base, 6)),
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

  /* 細項 */
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

  /* 連結 */
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

  /* 批次位移 */
  panel.querySelector("[data-kind='bulk-apply']").addEventListener("click", () => {
    const scope = panel.querySelector("[data-kind='bulk-scope']").value;
    const filter = panel.querySelector("[data-kind='bulk-filter']").value;
    const amount = Math.round(Number(panel.querySelector("[data-kind='bulk-amount']").value));
    const unit = panel.querySelector("[data-kind='bulk-unit']").value;
    const alsoMarkers = panel.querySelector("[data-kind='bulk-markers']").checked;
    if (!Number.isFinite(amount) || amount === 0) {
      alert("請填入非零的整數。");
      return;
    }
    applyBulkShift(scope, filter, amount * (unit === "week" ? 7 : 1), alsoMarkers);
  });

  /* 基準線 */
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

function applyBulkShift(scope, filter, days, alsoMarkers) {
  const targets = [];
  data.tracks.forEach((track, ti) => {
    if (scope !== "all" && scope !== `track:${ti}`) return;
    track.tasks.forEach((task) => {
      if (filter === "open" && task.status === "done") return;
      targets.push(task);
    });
  });
  if (!targets.length && !alsoMarkers) {
    alert("沒有符合條件的任務。");
    return;
  }

  let moved = 0, skipped = 0;
  targets.forEach((t) => {
    const s = parseISO(t.start), e = parseISO(t.end);
    if (!s || !e) {
      skipped++;
      return;
    }
    t.start = toISO(addDays(s, days));
    t.end = toISO(addDays(e, days));
    moved++;
  });

  let markersMoved = 0;
  if (alsoMarkers) {
    (data.phaseMarkers || []).forEach((m) => {
      const d = parseISO(m.date);
      if (!d) return;
      m.date = toISO(addDays(d, days));
      markersMoved++;
    });
  }

  markDirty();
  refreshView();
  renderEditPanel();

  const dir = days > 0 ? `往後 ${days}` : `往前 ${-days}`;
  setBanner(
    "bulk",
    skipped ? "warn" : "info",
    `已把 <strong>${moved}</strong> 個任務${markersMoved ? `與 ${markersMoved} 個里程碑` : ""}${dir} 天。${
      skipped ? `另有 ${skipped} 個任務因為缺少日期被略過。` : ""
    }`,
    [{ label: "知道了", run: () => dropBanner("bulk") }]
  );
}

/* ---------- 從 Excel 貼上匯入 ---------- */

const STATUS_ALIASES = {
  待辦: "upcoming", 未開始: "upcoming", upcoming: "upcoming", todo: "upcoming",
  進行中: "in-progress", 執行中: "in-progress", "in-progress": "in-progress", doing: "in-progress",
  已完成: "done", 完成: "done", done: "done", 結案: "done",
};

function parseImportText(text) {
  const lines = text.replace(/\r/g, "").split("\n").filter((l) => l.trim());
  if (!lines.length) return { rows: [], newTracks: [] };

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
      if (/結束|完成日/.test(c)) return "end";
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
    if (!rec.track) errors.push("缺少軌道");
    else if (trackByLabel[rec.track] != null) trackIndex = trackByLabel[rec.track];
    else if (!newTracks.includes(rec.track)) newTracks.push(rec.track);

    const s = coerceToISO(rec.start);
    const e = coerceToISO(rec.end);
    if (!s.iso) errors.push(rec.start ? `開始日期「${rec.start}」無法辨識` : "缺少開始日期");
    if (!e.iso) errors.push(rec.end ? `結束日期「${rec.end}」無法辨識` : "缺少結束日期");
    if (s.iso && e.iso && parseISO(e.iso) < parseISO(s.iso)) errors.push("結束日期早於開始日期");

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
      start: s.iso,
      end: e.iso,
      status,
      owner: rec.owner,
      note: rec.note,
      errors,
      fatal: errors.some((x) => /缺少|無法辨識|早於/.test(x)),
    });
  }

  return { rows, newTracks };
}

function renderImportPreview() {
  const box = $("import-preview");
  const { rows, newTracks } = importState;
  if (!rows.length) {
    box.innerHTML = "";
    $("import-confirm").disabled = true;
    return;
  }
  const ok = rows.filter((r) => !r.fatal);
  const bad = rows.filter((r) => r.fatal);

  const head = `<tr><th>#</th><th>軌道</th><th>任務</th><th>起訖</th><th>工期</th><th>狀態</th><th>負責人</th><th>問題</th></tr>`;
  const body = rows
    .slice(0, 30)
    .map((r) => {
      const days = r.start && r.end ? dayDiff(parseISO(r.end), parseISO(r.start)) + 1 : "—";
      return `
      <tr class="${r.fatal ? "row-bad" : r.errors.length ? "row-warn" : ""}">
        <td>${r.line}</td>
        <td>${escapeHtml(r.trackLabel)}${r.isNewTrack ? '<span class="tag-new">新軌道</span>' : ""}</td>
        <td>${escapeHtml(r.title)}</td>
        <td>${escapeHtml(r.start || "?")} ~ ${escapeHtml(r.end || "?")}</td>
        <td>${days}${days === "—" ? "" : " 天"}</td>
        <td>${STATUS_LABEL[r.status]}</td>
        <td>${escapeHtml(r.owner)}</td>
        <td>${escapeHtml(r.errors.join("；"))}</td>
      </tr>`;
    })
    .join("");

  const notes = [];
  if (newTracks.length) notes.push(`將新增 ${newTracks.length} 條軌道：${newTracks.join("、")}`);
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
  importState = { rows: [], newTracks: [] };
  renderImportPreview();
  $("import-textarea").focus();
}

function closeImport() {
  $("import-modal").style.display = "none";
}

function applyImport() {
  const { rows, newTracks } = importState;

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

  let added = 0;
  rows.forEach((r) => {
    if (r.fatal) return;
    const ti = labelToIndex[r.trackLabel.trim()];
    if (ti == null) return;
    data.tracks[ti].tasks.push({
      title: r.title,
      start: r.start,
      end: r.end,
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
    "info",
    `已匯入 <strong>${added}</strong> 個任務${newTracks.length ? `，新增 ${newTracks.length} 條軌道` : ""}。`,
    [{ label: "知道了", run: () => dropBanner("import") }]
  );
}

/* ---------- 編輯模式切換 ---------- */

async function enterEdit() {
  const btn = $("edit-toggle-btn");
  btn.disabled = true;
  btn.textContent = "檢查最新版本…";
  try {
    const fresh = await ghGetFile(filePath);
    if (fresh.json) {
      const migrated = migrateProject(fresh.json);
      const changed = JSON.stringify(migrated) !== JSON.stringify(data);
      migrationInfo = migrated._migration || null;
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
      `無法向 GitHub 取得最新版本（${escapeHtml(e.message)}）。仍可編輯，但這次<strong>無法安全儲存</strong>，請重新載入後再試。`,
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
  showMigrationBanner();
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
    migrationInfo = null;
    clearDraft();
    dropBanner("sha");
    dropBanner("migration");
    btn.textContent = "已儲存 ✓";
    setTimeout(updateDirtyIndicator, 2000);
    loadLastUpdated(true);
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

/* ---------- 檢視控制 ---------- */

$("scale-toggle").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-scale]");
  if (!b) return;
  scale = b.dataset.scale;
  localStorage.setItem(SCALE_KEY, scale);
  refreshView();
  scrollToToday();
});

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
$("import-modal").addEventListener("click", (e) => {
  if (e.target.id === "import-modal") closeImport();
});

/* ---------- 最後更新者 ---------- */

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
    /* 讀不到就不顯示 */
  }
}

/* ---------- 遷移提示 ---------- */

// 遷移只發生在記憶體裡，要按「儲存到 GitHub」才會寫回檔案。這點一定要講清楚。
function showMigrationBanner() {
  if (!migrationInfo) return;
  if (migrationInfo.synthesized) {
    setBanner(
      "migration",
      "warn",
      `這個專案原本是「期間」制排程<strong>且沒有填任何日期</strong>，無法換算成真實日期。
       目前畫面上的日期是用「第 1 期從 ${escapeHtml(formatDate(mondayOf(today())))} 開始、每期兩週」<strong>推算</strong>出來的，
       僅供起步用，請逐項確認後再儲存。<br />
       尚未寫回 GitHub —— 按「儲存到 GitHub」才會生效。`,
      [{ label: "我知道了", run: () => dropBanner("migration") }]
    );
  } else {
    setBanner(
      "migration",
      "info",
      `已依原本填寫的期間日期，把排程換算成實際起訖日期。請確認後儲存。
       尚未寫回 GitHub —— 按「儲存到 GitHub」才會生效。`,
      [{ label: "我知道了", run: () => dropBanner("migration") }]
    );
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

  scale = loadScale();
  data = migrateProject(raw);
  migrationInfo = data._migration || null;
  showBaseline = hasBaseline();
  refreshView();
  scrollToToday();
  showMigrationBanner();
  loadLastUpdated();

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
