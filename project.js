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
let pxPerDay = 7.7;         // 縮放的唯一狀態；scale 由它推導
const ZOOM_KEY = `gc-zoom:${projectId}`;
const LABEL_W = 170;        // 左側軌道名稱欄寬，與 CSS 的 grid-template-columns 一致
const MIN_PX = 1.5;
const MAX_PX = 40;

// 三個刻度各自的代表縮放值（也就是按刻度鈕時跳到的位置）
const SCALE_PX = { day: 26, week: 7.7, month: 2.9 };

// 由每天像素反推該用哪個刻度：欄位太窄就換更粗的刻度，標籤才讀得到
function scaleForPx(p) {
  if (p >= 13) return "day";
  if (p >= 3.4) return "week";
  return "month";
}

function clampPx(p) {
  return Math.min(MAX_PX, Math.max(MIN_PX, p));
}

// pxPerDay 只是「最小寬度」的依據：.gantt 用的是 min-width，容器更寬時圖表會被拉開，
// 實際每天的像素會大於 pxPerDay。任何要把「螢幕座標 ↔ 日期」互換的地方都必須量實際寬度，
// 否則在沒有溢出的縮放程度下會算錯位置。
function actualPxPerDay() {
  const chart = document.querySelector(".chart-col");
  if (!chart || !timeline || !timeline.totalDays) return pxPerDay;
  const w = chart.getBoundingClientRect().width;
  return w > 0 ? w / timeline.totalDays : pxPerDay;
}
let migrationInfo = null;
let importState = { rows: [], newTracks: [] };
let suppressClickUntil = 0; // 拖拉結束後短暫忽略 click，避免被當成點擊跳轉
let calendars = [];         // calendars/holidays.json 的每本日曆（含顏色）
let calIndex = {};          // 日曆 id → buildNonWorkingIndex 結果
let nonWorking = { holidays: new Map(), workdays: new Map() }; // 所有日曆的聯集

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

function loadZoom() {
  const z = Number(localStorage.getItem(ZOOM_KEY));
  if (z > 0) return clampPx(z);
  // 相容舊版只存刻度的設定
  const old = localStorage.getItem(SCALE_KEY);
  return SCALE_PX[SCALES.includes(old) ? old : "week"];
}

function setZoom(p) {
  pxPerDay = clampPx(p);
  scale = scaleForPx(pxPerDay);
  localStorage.setItem(ZOOM_KEY, String(pxPerDay));
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

/* ---------- 任務詳細內容的懸浮卡 ----------
   原本用原生 title 屬性：延遲約一秒、純文字、無法排版，長備註幾乎讀不了。
   改成自訂卡片，長條上就只留任務全名。 */

function taskDetailHtml(track, task) {
  const s = parseISO(task.start), e = parseISO(task.end);
  const row = (k, v) => `<div class="bh-row"><dt>${k}</dt><dd>${v}</dd></div>`;
  const parts = [];

  parts.push(`<div class="bh-head">
    <span class="bh-track" data-color="${track.color}">${escapeHtml(track.label)}</span>
    <strong class="bh-title">${escapeHtml(task.title || "未命名")}</strong>
  </div>`);

  if (s && e) {
    parts.push(
      row("起訖", `${formatDate(s)}${weekdayLabel(s)} ～ ${formatDate(e)}${weekdayLabel(e)}`)
    );
    parts.push(row("日曆天", `${taskDays(task)} 天`));
    // 台灣與大陸的可工作天數不同，分開列才有意義
    calendars.forEach((cal) => {
      const ix = calIndex[cal.id];
      const wd = workingDays(task.start, task.end, ix);
      const bd = nonWorkingBreakdown(task.start, task.end, ix);
      const extra = bd.holiday
        ? `<span class="bh-sub">扣 ${bd.holiday} 天：${escapeHtml(bd.labels.join("、"))}</span>`
        : "";
      parts.push(
        row(
          `<span class="bh-dot" style="background:${cal.color}"></span>${escapeHtml(cal.label.replace("國定假日", ""))}可工作`,
          `${wd} 天${extra}`
        )
      );
    });
  } else {
    parts.push(row("日期", `<span class="bad">⚠ 缺少日期</span>`));
  }

  parts.push(row("狀態", escapeHtml(STATUS_LABEL[task.status])));
  if (task.owner) parts.push(row("負責人", escapeHtml(task.owner)));

  const subs = task.subtasks || [];
  if (subs.length) {
    const list = subs
      .map((x) => `<li class="${x.done ? "done" : ""}">${x.done ? "☑" : "☐"} ${escapeHtml(x.title)}</li>`)
      .join("");
    parts.push(row(`細項 ${subs.filter((x) => x.done).length}/${subs.length}`, `<ul class="bh-subs">${list}</ul>`));
  }

  const bd = baselineDelta(task);
  if (bd) parts.push(row("對比基準線", `<span class="bh-delta ${bd.direction}">${escapeHtml(bd.text)}</span>`));

  if (task.note) parts.push(row("備註", `<span class="bh-note">${escapeHtml(task.note)}</span>`));

  const links = task.links || [];
  if (links.length) {
    parts.push(row("連結", links.map((l) => escapeHtml(l.label || l.url)).join("、")));
  }

  parts.push(`<div class="bh-foot">點一下長條可跳到這個任務的編輯欄位</div>`);
  return `<dl class="bh-body">${parts.join("")}</dl>`;
}

let hoverBar = null;

function showHoverCard(bar, track, task) {
  const card = $("bar-hover");
  if (!card) return;
  hoverBar = bar;
  card.innerHTML = taskDetailHtml(track, task);
  card.hidden = false;
  positionHoverCard(bar);
}

function hideHoverCard() {
  const card = $("bar-hover");
  if (!card) return;
  card.hidden = true;
  hoverBar = null;
}

// 貼著長條下緣顯示；碰到視窗邊緣就翻到上方或往內收
function positionHoverCard(bar) {
  const card = $("bar-hover");
  const r = bar.getBoundingClientRect();
  const cw = card.offsetWidth;
  const ch = card.offsetHeight;
  const pad = 8;

  let left = r.left;
  if (left + cw > window.innerWidth - pad) left = window.innerWidth - cw - pad;
  if (left < pad) left = pad;

  let top = r.bottom + pad;
  if (top + ch > window.innerHeight - pad) top = r.top - ch - pad;
  if (top < pad) top = pad;

  card.style.left = `${Math.round(left)}px`;
  card.style.top = `${Math.round(top)}px`;
}

function attachHoverCard(bar, track, task) {
  bar.addEventListener("mouseenter", () => showHoverCard(bar, track, task));
  bar.addEventListener("mouseleave", hideHoverCard);
  // 鍵盤操作也要看得到（長條本身是 tabindex=0 的按鈕）
  bar.addEventListener("focus", () => showHoverCard(bar, track, task));
  bar.addEventListener("blur", hideHoverCard);
}

// 卡片是 fixed 定位，長條會隨捲動移動，所以要跟著重新定位。
// 不能改成「捲動就收起」：用鍵盤 focus 到長條時瀏覽器會自動把它捲進畫面，
// 那個捲動事件會立刻把剛剛顯示的卡片關掉。
["scroll", "resize"].forEach((ev) =>
  window.addEventListener(
    ev,
    () => {
      if (!hoverBar) return;
      if (!hoverBar.isConnected) return hideHoverCard();
      positionHoverCard(hoverBar);
    },
    { passive: true, capture: true }
  )
);

/* ---------- 甘特圖（日期軸） ---------- */

function pct(n) {
  return `${n}%`;
}

function renderGantt() {
  // 重繪會把長條整批換掉，正在顯示的懸浮卡會指向已移除的元素
  hideHoverCard();
  timeline = buildTimeline(data, scale);
  const tl = timeline;

  $("range-label").textContent = `${formatDateShort(tl.start)} – ${formatDateShort(tl.end)}`;

  // 寬度直接由「每天幾像素」決定，這樣 Ctrl+滾輪的縮放才是連續的
  document.querySelector(".gantt").style.minWidth = `${Math.round(LABEL_W + tl.totalDays * pxPerDay)}px`;

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

  // 里程碑標籤：依日期定位，靠邊時調整對齊避免被切掉。
  // 名稱下面直接標出日期，不必滑上去看 tooltip 才知道 NPI 是哪一天。
  $("marker-row").innerHTML = (data.phaseMarkers || [])
    .map((m) => {
      const d = parseISO(m.date);
      const p = datePct(m.date, tl);
      if (p === null || !d) return "";
      const align = p < 4 ? "start" : p > 96 ? "end" : "mid";
      return `<div class="marker ${m.highlight ? "highlight" : "normal"}" data-align="${align}" style="left:${pct(p)}" title="${escapeHtml(
        m.label + " ・ " + formatDate(d) + weekdayLabel(d)
      )}">
        <span class="marker-label">${escapeHtml(m.label)}</span>
        <span class="marker-date">${escapeHtml(formatDateShort(d))}</span>
      </div>`;
    })
    .join("");

  // 今天旗標和里程碑名稱一樣屬於「文字」，放在表頭的第三條車道，
  // 垂直線則另外畫在圖表區裡（見下方 chart-overlay），才不會蓋到文字。
  const tp = todayPosition(tl);
  if (tp.inRange) {
    $("marker-row").insertAdjacentHTML(
      "beforeend",
      `<div class="today-flag" style="left:${pct(tp.pct)}">今天 ${formatDateShort(tp.date)}</div>`
    );
  }
  $("today-note").textContent = tp.inRange ? "" : `今天（${formatDate(tp.date)}）不在這個專案的排程範圍內`;

  // 主體
  const bodyEl = $("gantt-body");
  const labelCol = document.createElement("div");
  labelCol.className = "track-label-col";
  const chartCol = document.createElement("div");
  chartCol.className = "chart-col";
  chartCol.style.gridColumn = "2";

  // 週末與假日的底色帶。放在最前面，所以會在任務長條之下。
  const bands = document.createElement("div");
  bands.className = "day-bands";
  bands.innerHTML = buildDayBands(tl);
  chartCol.appendChild(bands);

  // 欄位分隔線
  const gridLines = document.createElement("div");
  gridLines.className = "col-lines";
  // 日刻度下每天都畫線會變成一片格子，只在每週一畫
  gridLines.innerHTML = tl.columns
    .slice(1)
    .filter((c) => (tl.scale === "day" ? c.weekStart : true))
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

    // 日期不重疊的任務共用一列，整張圖才不會被拉得很高
    const lanes = packIntoLanes(track.tasks);
    lanes.forEach(() => {
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

    lanes.forEach((lane) => {
      const row = document.createElement("div");
      row.className = "task-row";
      lane.forEach(({ task, index: tj }) => buildTaskBar(row, track, ti, task, tj, tl, chartCol));
      rows.appendChild(row);
    });
    chartCol.appendChild(rows);
  });

  // 里程碑虛線與今天線：畫成圖表區的覆蓋層，最後才加所以會在長條之上，
  // 但因為只佔圖表區高度，不會延伸到表頭去蓋住里程碑名稱與日期刻度。
  const overlay = document.createElement("div");
  overlay.className = "chart-overlay";
  overlay.innerHTML =
    (data.phaseMarkers || [])
      .map((m) => {
        const p = datePct(m.date, tl);
        return p === null ? "" : `<div class="marker-line${m.highlight ? " highlight" : ""}" style="left:${pct(p)}"></div>`;
      })
      .join("") + (tp.inRange ? `<div class="today-line" style="left:${pct(tp.pct)}"></div>` : "");
  chartCol.appendChild(overlay);

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
    bar.classList.remove("label-outside");

    // 兩個把手共 18px，長條比這窄的話把手會蓋掉整根，點擊與跳轉都失效
    bar.classList.toggle("no-handles", bar.clientWidth < 26);
    bar.classList.remove("label-hidden");

    const clipped = label.scrollWidth > label.clientWidth + 1;
    const tooNarrowToRead = bar.clientWidth < 56;
    if (!clipped && !tooNarrowToRead) return;

    // 同一列現在可能有多根長條。若右邊緊接著下一根，把標籤移到外面會疊在它上面，
    // 那還不如維持裁切。
    const room = spaceToNextBar(bar);
    if (room === null || room >= label.scrollWidth + 8) {
      bar.classList.add("label-outside");
      return;
    }

    // 極窄的長條連一個字都放不下（標籤自身的內距就比長條寬），
    // 硬留著只會擠出邊界又什麼都看不到，直接不顯示，資訊交給懸浮卡。
    if (bar.clientWidth < 16) bar.classList.add("label-hidden");
  });
}

// 同一列中，這根長條右緣到下一根長條左緣的距離；沒有下一根則回傳 null
function spaceToNextBar(bar) {
  const row = bar.parentElement;
  if (!row) return null;
  const r = bar.getBoundingClientRect();
  let nearestLeft = null;
  row.querySelectorAll(".task-bar").forEach((other) => {
    if (other === bar) return;
    const o = other.getBoundingClientRect();
    if (o.left >= r.right - 1) {
      nearestLeft = nearestLeft === null ? o.left : Math.min(nearestLeft, o.left);
    }
  });
  return nearestLeft === null ? null : nearestLeft - r.right;
}

// 把連續的同類日子合併成一條帶子，避免 238 天各畫一格。
// pick(iso, date) 回傳該日的標籤，null 表示不畫。
function bandRuns(tl, pick) {
  const runs = [];
  let run = null;
  for (let d = tl.start; d <= tl.end; d = addDays(d, 1)) {
    const label = pick(toISO(d), d);
    if (!label) {
      run = null;
      continue;
    }
    if (run && run.label === label && dayDiff(d, run.to) === 1) {
      run.to = d;
    } else {
      run = { from: d, to: d, label };
      runs.push(run);
    }
  }
  return runs.map((r) => ({
    label: r.label,
    left: (dayDiff(r.from, tl.start) / tl.totalDays) * 100,
    width: ((dayDiff(r.to, r.from) + 1) / tl.totalDays) * 100,
    from: r.from,
    to: r.to,
  }));
}

// 每本日曆一個顏色、一條 cap 車道，所以同一天兩邊都放假時看得出是哪兩邊
function buildDayBands(tl) {
  const out = [];

  // 週末（灰）：只有在沒有任何日曆標記的日子才單獨畫，避免和假日重疊變濁
  bandRuns(tl, (iso, d) => (isWeekend(d) && !nonWorking.holidays.has(iso) ? "週末" : null)).forEach((r) => {
    out.push(`<div class="day-band weekend" style="left:${r.left}%;width:${r.width}%" title="週末"></div>`);
  });

  calendars.forEach((cal, lane) => {
    const ix = calIndex[cal.id];
    if (!ix) return;
    bandRuns(tl, (iso) => ix.holidays.get(iso) || null).forEach((r) => {
      const tip = `${cal.label}：${r.label}（${formatDate(r.from)}${
        toISO(r.from) === toISO(r.to) ? "" : " ~ " + formatDate(r.to)
      }）`;
      out.push(
        `<div class="day-band cal" style="left:${r.left}%;width:${r.width}%;background:${cal.color}1f" title="${escapeHtml(tip)}">
           <span class="band-cap" style="background:${cal.color};top:${lane * 4}px"></span>
         </div>`
      );
    });
  });

  return out.join("");
}

function calSwatch(color) {
  // 和甘特圖上的假日帶同樣構成：淡色底 + 頂端色條，這樣顏色才對得起來
  return `<span class="legend-swatch cal-swatch" style="background:${color}33;box-shadow:inset 0 3px 0 ${color}"></span>`;
}

function renderHolidayLegend() {
  const slot = $("cal-legend");
  if (!slot) return;
  slot.innerHTML = calendars
    .map((c) => `<div class="legend-item">${calSwatch(c.color)}${escapeHtml(c.label)}</div>`)
    .join("");
}

// 光給色塊看不出「到底標了哪幾天」，所以把每本日曆實際標記的日期全部列出來，
// 並把需要向官方核對的項目標明，避免被當成已確認的資料使用。
function renderHolidayNotes() {
  const slot = $("holiday-notes");
  if (!slot) return;
  if (!calendars.length) {
    slot.innerHTML = "";
    return;
  }

  const fmtRange = (r) => {
    const s = parseISO(r.start), e = parseISO(r.end || r.start);
    if (!s) return escapeHtml(r.start || "");
    const one = !e || toISO(s) === toISO(e);
    return one
      ? `${formatDateShort(s)}${weekdayLabel(s)}`
      : `${formatDateShort(s)} – ${formatDateShort(e)}（${dayDiff(e, s) + 1} 天）`;
  };

  const totalVerify = calendars.reduce(
    (n, c) => n + (c.ranges || []).filter((r) => r.verify).length,
    0
  );

  const blocks = calendars
    .map((c) => {
      const ix = calIndex[c.id];
      const items = (c.ranges || [])
        .slice()
        .sort((a, b) => (a.start < b.start ? -1 : 1))
        .map(
          (r) => `
        <li${r.verify ? ' class="needs-verify"' : ""}>
          <span class="cal-date">${fmtRange(r)}</span>
          <span class="cal-name">${escapeHtml(r.label)}</span>
          ${r.verify ? `<span class="verify-tag" title="${escapeHtml(r.verify)}">待核對</span>` : ""}
          ${r.note ? `<span class="cal-extra">${escapeHtml(r.note)}</span>` : ""}
        </li>`
        )
        .join("");
      return `
      <div class="cal-block">
        <h4 style="border-left-color:${c.color}">
          ${calSwatch(c.color)}${escapeHtml(c.label)}
          <span class="cal-count">${(c.ranges || []).length} 項 ・ 共 ${ix ? ix.holidays.size : 0} 個非工作日</span>
        </h4>
        <ul class="cal-list">${items}</ul>
      </div>`;
    })
    .join("");

  slot.innerHTML = `
    <details open>
      <summary>假日標示說明${totalVerify ? `　<span class="verify-tag">${totalVerify} 項待核對</span>` : ""}</summary>
      <p class="hint">甘特圖上的直向色帶就是下列日期。灰色是週末（系統自動計算），各地假日各有顏色；同一天兩邊都放假時，兩條色條會分上下顯示。</p>
      <div class="cal-blocks">${blocks}</div>
      <p class="hint">標「待核對」的是我無法確定的項目 —— 台灣補假由行政院人事行政總處公告、大陸放假與調休由國務院辦公廳公告，通常前一年底才定案。核對後請編輯
        <code>calendars/holidays.json</code> 把該筆的 <code>verify</code> 欄刪掉，所有天數會自動重算。</p>
    </details>`;
}

async function loadHolidays() {
  try {
    const res = await fetch(`calendars/holidays.json?_=${Date.now()}`);
    if (!res.ok) return;
    const json = await res.json();
    calendars = Array.isArray(json.calendars) ? json.calendars : [];
    calIndex = {};
    calendars.forEach((c) => (calIndex[c.id] = buildNonWorkingIndex(c.ranges)));
    nonWorking = mergeNonWorkingIndexes(calendars.map((c) => calIndex[c.id]));
  } catch (e) {
    /* 沒有假日檔就只顯示週末 */
  }
}

// 把一個任務的長條（含基準線幽靈條）建到指定的列上。
// 因為現在一列可能有多根長條，所以抽成獨立函式。
function buildTaskBar(row, track, ti, task, tj, tl, chartCol) {
  const geo = taskGeometry(task, tl);

  if (!geo) {
    const bad = document.createElement("div");
    bad.className = "task-bar invalid";
    bad.dataset.color = track.color;
    bad.style.left = "0%";
    bad.innerHTML = `<span class="bar-label"><span class="bar-title">⚠ ${escapeHtml(task.title || "未命名")}（缺少日期）</span></span>`;
    attachHoverCard(bad, track, task);
    attachJumpToEditor(bad, ti, tj);
    row.appendChild(bad);
    return;
  }

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
  // 扣 2px：同一列相鄰的兩個任務（前一項結束隔天就是下一項）才不會看起來連成一根
  bar.style.width = `calc(${geo.width}% - 2px)`;

  // 長條上只寫任務全名，其餘資訊一律進懸浮卡
  const prog = Math.round(taskProgress(task) * 100);
  bar.innerHTML = `
    ${prog > 0 && prog < 100 ? `<span class="bar-fill" style="width:${prog}%"></span>` : ""}
    <span class="bar-label"><span class="bar-title">${escapeHtml(task.title)}</span></span>`;
  attachHoverCard(bar, track, task);

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
    if (!chartEl.getBoundingClientRect().width) return;
    const dragPxPerDay = actualPxPerDay(); // 用實際渲染寬度，不是全域的 pxPerDay（那只是最小值）

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
      bar.style.width = `calc(${Math.max(width, 0.4)}% - 2px)`;
      hint.textContent = `${formatDateShort(ns)} – ${formatDateShort(ne)}（${dayDiff(ne, ns) + 1} 天）`;
    };

    const onMove = (ev) => {
      const d = Math.round((ev.clientX - startX) / dragPxPerDay);
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
  if (d) d.innerHTML = daysBadgeHtml(t);
}

/* ---------- 編輯面板 ---------- */

// 日曆天 + 每本日曆各自的可工作天數，顏色與甘特圖上的假日帶一致
function daysBadgeHtml(task) {
  const per = calendars
    .map(
      (cal) =>
        `<em style="color:${cal.color}" title="${escapeHtml(cal.label)}">${workingDays(task.start, task.end, calIndex[cal.id])}</em>`
    )
    .join("");
  return `${taskDays(task)} 天${per}`;
}

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
            <span class="days-badge" data-days="${ti}-${tj}" title="日曆天 ／ 各地可工作天數">${daysBadgeHtml(task)}</span>
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

function taskHeaderKey(c) {
  if (/軌道|分類/.test(c)) return "track";
  if (/任務|項目|名稱/.test(c)) return "title";
  if (/開始/.test(c)) return "start";
  if (/結束|完成日/.test(c)) return "end";
  if (/狀態/.test(c)) return "status";
  if (/負責|owner/i.test(c)) return "owner";
  if (/備註|說明|note/i.test(c)) return "note";
  return null;
}

// 從 Excel 讀回來的日期常常是「1899-12-30 起算的天數」這種序號，
// 使用者在範本裡打 2026-09-01，Excel 就會自動轉成 46266 之類的數字。
// 所以純數字先當序號解讀，其他才走文字格式。
function cellToISO(v) {
  const s = String(v == null ? "" : v).trim();
  if (!s) return { iso: "", legacy: "" };
  if (/^\d+(\.\d+)?$/.test(s)) {
    const iso = excelSerialToISO(s);
    return iso ? { iso, legacy: "" } : { iso: "", legacy: s };
  }
  return coerceToISO(s);
}

// 貼上匯入與檔案匯入共用同一套驗證，避免兩條路徑對「什麼算合法」有不同標準
function parseTaskRows(rows) {
  if (!rows || !rows.length) return { rows: [], newTracks: [] };

  let order = ["track", "title", "start", "end", "status", "owner", "note"];
  let bodyStart = 0;
  const head = rows[0].map((c) => String(c == null ? "" : c).trim());
  if (head.some((c) => /軌道|任務|開始|結束|狀態|負責|備註/.test(c))) {
    bodyStart = 1;
    order = head.map(taskHeaderKey);
  }

  const trackByLabel = {};
  data.tracks.forEach((t, i) => (trackByLabel[t.label.trim()] = i));
  const newTracks = [];
  const out = [];

  for (let li = bodyStart; li < rows.length; li++) {
    const cells = (rows[li] || []).map((c) => String(c == null ? "" : c).trim());
    if (!cells.some((c) => c !== "")) continue; // 跳過空白列

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

    const s = cellToISO(rec.start);
    const e = cellToISO(rec.end);
    if (!s.iso) errors.push(rec.start ? `開始日期「${rec.start}」無法辨識` : "缺少開始日期");
    if (!e.iso) errors.push(rec.end ? `結束日期「${rec.end}」無法辨識` : "缺少結束日期");
    if (s.iso && e.iso && parseISO(e.iso) < parseISO(s.iso)) errors.push("結束日期早於開始日期");

    const statusKey = rec.status.toLowerCase();
    const status = STATUS_ALIASES[rec.status] || STATUS_ALIASES[statusKey] || "upcoming";
    if (rec.status && !STATUS_ALIASES[rec.status] && !STATUS_ALIASES[statusKey]) {
      errors.push(`狀態「${rec.status}」無法辨識，會當成待辦`);
    }

    out.push({
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

  return { rows: out, newTracks };
}

function parseImportText(text) {
  return parseTaskRows(parseDelimited(text));
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

/* ---------- Excel 範本下載 ---------- */

const TASK_HEADERS = ["軌道", "任務名稱", "開始日期", "結束日期", "狀態", "負責人", "備註"];
const MARKER_HEADERS = ["里程碑名稱", "日期", "強調（填「是」會反白）"];

function safeFileName(s) {
  return String(s || "專案").replace(/[\\/:*?"<>|]/g, "_").slice(0, 60);
}

function buildTemplateSheets() {
  const trackList = data.tracks.map((t) => t.label).join("、") || "（這個專案還沒有軌道）";
  const example = toISO(mondayOf(today()));
  const exampleEnd = toISO(addDays(mondayOf(today()), 13));

  const guide = [
    ["專案排程追蹤 ・ Excel 範本填寫說明"],
    [""],
    ["1.", "在「任務」工作表填入排程，一列一個任務。範例列可以直接改掉或刪掉。"],
    ["2.", "日期用 2026-09-01 這種格式，或直接用 Excel 的日期格式都可以，系統兩種都讀得懂。"],
    ["3.", "「軌道」是任務的分類。填入目前沒有的軌道名稱，匯入時會自動建立新軌道。"],
    ["4.", "「狀態」只能填 待辦 / 進行中 / 已完成。留空視為待辦。"],
    ["5.", "「里程碑」工作表填階段節點（例如 Award、NPI、MP），會在甘特圖上畫垂直線。"],
    ["", "　　這張工作表留空的話，原本的里程碑會保留不動。"],
    ["6.", "「專案資訊」工作表可改專案名稱與說明。留空則沿用原本的。"],
    ["7.", "填好後回到網站，點右上角「📤 匯入 Excel」上傳這個檔案。"],
    ["8.", "上傳後會先顯示預覽，可選擇「新增到現有排程」或「取代整個排程」，確認後才會套用。"],
    ["9.", "套用只在畫面上生效，還要按「儲存到 GitHub」才會真正存檔。"],
    [""],
    ["這個專案目前的軌道：", trackList],
    ["注意：", "不要改動工作表名稱與標題列，系統靠它們辨識欄位。"],
  ];

  const info = [
    ["欄位", "內容"],
    ["專案名稱", data.project.name || ""],
    ["專案說明", data.project.description || ""],
  ];

  const markers = [
    MARKER_HEADERS,
    ["Award", example, ""],
    ["NPI", exampleEnd, "是"],
  ];

  const tasks = [
    TASK_HEADERS,
    ["產品", "DFM", example, exampleEnd, "進行中", "王小明", "這是範例列，請改成實際內容"],
    ["包裝", "彩盒打樣", example, exampleEnd, "待辦", "", ""],
  ];

  return [
    { name: "填寫說明", rows: guide, widths: [16, 92], headerRows: 1 },
    { name: "專案資訊", rows: info, widths: [16, 60] },
    { name: "里程碑", rows: markers, widths: [22, 14, 22] },
    { name: "任務", rows: tasks, widths: [14, 30, 14, 14, 10, 12, 34] },
  ];
}

$("tpl-download-btn").addEventListener("click", () => {
  try {
    const blob = buildXlsx(buildTemplateSheets());
    downloadBlob(blob, `${safeFileName(data.project.name)}-排程範本.xlsx`);
  } catch (e) {
    alert(`產生範本失敗：${e.message}`);
  }
});

/* ---------- Excel 範本上傳 ---------- */

let uploadState = null;

function parseMarkerRows(rows) {
  if (!rows || !rows.length) return { rows: [], provided: false };
  let bodyStart = 0;
  const head = rows[0].map((c) => String(c == null ? "" : c).trim());
  if (head.some((c) => /里程碑|名稱|日期|強調/.test(c))) bodyStart = 1;

  const out = [];
  for (let i = bodyStart; i < rows.length; i++) {
    const cells = (rows[i] || []).map((c) => String(c == null ? "" : c).trim());
    const [label, rawDate, hi] = [cells[0] || "", cells[1] || "", cells[2] || ""];
    if (!label && !rawDate) continue;

    const d = cellToISO(rawDate);
    const errors = [];
    if (!label) errors.push("缺少里程碑名稱");
    if (!d.iso) errors.push(rawDate ? `日期「${rawDate}」無法辨識` : "缺少日期");

    out.push({
      line: i + 1,
      label,
      date: d.iso,
      highlight: /^(是|y|yes|true|1|✓|v|o)$/i.test(hi),
      errors,
      fatal: errors.length > 0,
    });
  }
  return { rows: out, provided: out.length > 0 };
}

async function loadUploadFile(file) {
  let taskRows = [];
  let markerRows = [];
  const info = {};
  const isXlsx = /\.xlsx$/i.test(file.name);

  if (isXlsx) {
    const sheets = await readXlsx(await file.arrayBuffer());
    const pick = (re) => {
      const key = Object.keys(sheets).find((n) => re.test(n));
      return key ? sheets[key] : [];
    };
    taskRows = pick(/任務|task/i);
    markerRows = pick(/里程碑|milestone/i);

    pick(/專案資訊|專案|project.?info/i).forEach((r) => {
      const k = String(r[0] || "").trim();
      const v = String(r[1] || "").trim();
      if (/名稱/.test(k)) info.name = v;
      else if (/說明|描述/.test(k)) info.description = v;
    });

    // 找不到叫「任務」的工作表就退而用第一張有資料的
    if (!taskRows.length) {
      const first = Object.keys(sheets).find((n) => (sheets[n] || []).length > 1);
      taskRows = first ? sheets[first] : [];
    }
  } else {
    taskRows = parseDelimited(await file.text());
  }

  uploadState = {
    fileName: file.name,
    isXlsx,
    tasks: parseTaskRows(taskRows),
    markers: parseMarkerRows(markerRows),
    info,
  };
  openUpload();
}

function openUpload() {
  $("upload-modal").style.display = "flex";
  renderUploadPreview();
}

function closeUpload() {
  $("upload-modal").style.display = "none";
}

function renderUploadPreview() {
  if (!uploadState) return;
  const { fileName, isXlsx, tasks, markers, info } = uploadState;
  const ok = tasks.rows.filter((r) => !r.fatal);
  const bad = tasks.rows.filter((r) => r.fatal);
  const okMarkers = markers.rows.filter((r) => !r.fatal);
  const badMarkers = markers.rows.filter((r) => r.fatal);

  $("upload-file").innerHTML = `檔案：<strong>${escapeHtml(fileName)}</strong>　<span class="hint inline">${
    isXlsx ? "Excel 工作表" : "CSV / TSV 文字檔（只讀任務）"
  }</span>`;

  const notes = [];
  if (tasks.newTracks.length) notes.push(`將新增 ${tasks.newTracks.length} 條軌道：${tasks.newTracks.join("、")}`);
  if (markers.provided) {
    notes.push(`里程碑會被檔案內容<strong>整批取代</strong>（${okMarkers.length} 個有效${badMarkers.length ? `，${badMarkers.length} 個有問題會略過` : ""}）`);
  } else if (isXlsx) {
    notes.push("「里程碑」工作表沒有資料，原本的里程碑保留不動");
  }
  if (info.name && info.name !== data.project.name) notes.push(`專案名稱會改成「${escapeHtml(info.name)}」`);
  if (info.description && info.description !== data.project.description) notes.push("專案說明會被更新");
  if (!ok.length) notes.push("沒有任何可匯入的任務，請檢查欄位與日期格式");

  $("upload-summary").innerHTML = `
    <div class="import-summary">可匯入 <strong>${ok.length}</strong> 個任務${
    bad.length ? ` ・ <span class="bad">${bad.length} 列有問題會略過</span>` : ""
  }</div>
    ${notes.length ? `<ul class="import-notes">${notes.map((n) => `<li>${n}</li>`).join("")}</ul>` : ""}`;

  const rowsHtml = tasks.rows
    .slice(0, 25)
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

  const markerHtml = markers.rows.length
    ? `<h4 class="preview-title">里程碑</h4>
       <div class="import-table-scroll"><table class="import-table">
       <tr><th>#</th><th>名稱</th><th>日期</th><th>強調</th><th>問題</th></tr>
       ${markers.rows
         .slice(0, 20)
         .map(
           (m) => `<tr class="${m.fatal ? "row-bad" : ""}"><td>${m.line}</td><td>${escapeHtml(m.label)}</td><td>${escapeHtml(
             m.date || "?"
           )}</td><td>${m.highlight ? "是" : ""}</td><td>${escapeHtml(m.errors.join("；"))}</td></tr>`
         )
         .join("")}
       </table></div>`
    : "";

  $("upload-preview").innerHTML = `
    ${
      tasks.rows.length
        ? `<h4 class="preview-title">任務${tasks.rows.length > 25 ? `（只顯示前 25 列，共 ${tasks.rows.length} 列）` : ""}</h4>
           <div class="import-table-scroll"><table class="import-table">
           <tr><th>#</th><th>軌道</th><th>任務</th><th>起訖</th><th>工期</th><th>狀態</th><th>負責人</th><th>問題</th></tr>
           ${rowsHtml}</table></div>`
        : ""
    }
    ${markerHtml}`;

  $("upload-confirm").disabled = ok.length === 0 && !markers.provided && !info.name;
}

async function applyUpload() {
  if (!uploadState) return;
  const mode = document.querySelector("input[name='upload-mode']:checked").value;
  const { tasks, markers, info } = uploadState;

  closeUpload();

  // 先進編輯模式，確保是在 GitHub 上的最新版本之上套用
  if (!editMode) await enterEdit();

  if (mode === "replace") {
    data.tracks.forEach((t) => (t.tasks = []));
  }

  const labelToIndex = {};
  data.tracks.forEach((t, i) => (labelToIndex[t.label.trim()] = i));
  let createdTracks = 0;
  tasks.newTracks.forEach((label) => {
    if (labelToIndex[label] != null) return;
    data.tracks.push({
      key: `track-${data.tracks.length + 1}`,
      label,
      color: TRACK_COLORS[data.tracks.length % TRACK_COLORS.length],
      tasks: [],
    });
    labelToIndex[label] = data.tracks.length - 1;
    createdTracks++;
  });

  let added = 0;
  tasks.rows.forEach((r) => {
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

  let markerCount = 0;
  if (markers.provided) {
    const valid = markers.rows.filter((m) => !m.fatal);
    data.phaseMarkers = valid.map((m) => ({ label: m.label, date: m.date, highlight: m.highlight }));
    markerCount = valid.length;
  }

  if (info.name) data.project.name = info.name;
  if (info.description) data.project.description = info.description;

  markDirty();
  refreshView();
  renderEditPanel();
  scrollToToday();

  const parts = [`匯入 <strong>${added}</strong> 個任務`];
  if (mode === "replace") parts.push("並清掉原有任務");
  if (createdTracks) parts.push(`新增 ${createdTracks} 條軌道`);
  if (markerCount) parts.push(`套用 ${markerCount} 個里程碑`);
  setBanner(
    "upload",
    "info",
    `已${parts.join("、")}。<strong>尚未儲存</strong> —— 確認無誤後請按「儲存到 GitHub」。`,
    [{ label: "知道了", run: () => dropBanner("upload") }]
  );
  uploadState = null;
}

$("tpl-upload-btn").addEventListener("click", () => $("tpl-file-input").click());

$("tpl-file-input").addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = ""; // 清掉才能重複選同一個檔案
  if (!file) return;
  try {
    await loadUploadFile(file);
  } catch (err) {
    alert(`讀取「${file.name}」失敗：${err.message}`);
  }
});

$("upload-close").addEventListener("click", closeUpload);
$("upload-cancel").addEventListener("click", closeUpload);
$("upload-confirm").addEventListener("click", applyUpload);
$("upload-modal").addEventListener("click", (e) => {
  if (e.target.id === "upload-modal") closeUpload();
});
document.querySelectorAll("input[name='upload-mode']").forEach((el) =>
  el.addEventListener("change", renderUploadPreview)
);

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
      `無法向 GitHub 取得最新版本（${escapeHtml(e.message)}）。仍可編輯，但這次<strong>無法安全儲存</strong>。`,
      [
        { label: "重新載入", run: () => window.location.reload() },
        { label: "知道了", run: () => dropBanner("sha") },
      ]
    );
  } finally {
    btn.disabled = false;
  }

  // 讀取成功但 token 被拒（已退回匿名讀取）：現在就講清楚，
  // 不要等使用者排完一整週的調整、按下儲存才發現存不進去。
  if (wasTokenRejected()) {
    setBanner(
      "token-expired",
      "warn",
      `你儲存的 GitHub Token <strong>已失效或過期</strong>（GitHub 回 401）。
       目前是用匿名方式讀取，所以檢視和編輯都正常，但<strong>儲存前必須重新輸入 token</strong>。`,
      [
        { label: "重新輸入 Token", run: fixToken },
        { label: "稍後再說", run: () => dropBanner("token-expired") },
      ]
    );
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

// 專案頁原本沒有 token 入口（只在首頁），token 過期時使用者無處可改
async function fixToken() {
  const diag = await ghPromptAndVerifyToken();
  if (!diag) return; // 使用者按取消
  setBanner("token-expired", diag.ok ? "info" : "error", ghTokenFixHtml(diag), [
    { label: "知道了", run: () => dropBanner("token-expired") },
  ]);
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
    if (e.isPermission) {
      setBanner("conflict", "warn", "寫入被拒絕，正在檢查 Token 權限…");
      const diag = await ghDiagnoseToken();
      setBanner("conflict", "error", ghTokenFixHtml(diag), [
        { label: "知道了", run: () => dropBanner("conflict") },
      ]);
    } else if (e.isConflict) {
      setBanner("conflict", "error", escapeHtml(e.message), [
        { label: "重新載入最新版本", run: () => window.location.reload() },
      ]);
    } else if (/401|無效|過期/.test(e.message)) {
      // ghPutFile 遇到 401 會清掉 token，這裡直接給重新輸入的入口
      setBanner("token-expired", "error", `${escapeHtml(e.message)}　你的變更還在畫面上，重新輸入 token 後再按儲存即可。`, [
        { label: "重新輸入 Token", run: fixToken },
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
  setZoom(SCALE_PX[b.dataset.scale] || SCALE_PX.week);
  refreshView();
  scrollToToday();
});

/* ---------- Ctrl + 滾輪縮放 ---------- */

// 縮放時游標下的那一天必須留在原位，否則畫面會亂跳。
// 因為換刻度時 timeline.start 也會變（週對齊到週一、月對齊到 1 號），
// 所以要記「游標下的實際日期」再換算回新的位置，不能只記像素偏移。
function dateAtClientX(clientX) {
  const scroller = $("gantt-scroll");
  const rect = scroller.getBoundingClientRect();
  const xInContent = scroller.scrollLeft + (clientX - rect.left) - LABEL_W;
  return addDays(timeline.start, Math.round(xInContent / actualPxPerDay()));
}

function scrollDateToClientX(date, clientX) {
  const scroller = $("gantt-scroll");
  const rect = scroller.getBoundingClientRect();
  const target = LABEL_W + dayDiff(date, timeline.start) * actualPxPerDay();
  scroller.scrollLeft = target - (clientX - rect.left);
}

$("gantt-scroll").addEventListener(
  "wheel",
  (e) => {
    // 沒按 Ctrl 就維持原本的捲動行為；觸控板的雙指縮放也會帶 ctrlKey
    if (!e.ctrlKey) return;
    e.preventDefault(); // 不讓瀏覽器整頁縮放

    const anchorDate = dateAtClientX(e.clientX);
    const before = pxPerDay;
    setZoom(pxPerDay * Math.exp(-e.deltaY * 0.0022));
    if (pxPerDay === before) return; // 已到縮放上下限

    refreshView();
    scrollDateToClientX(anchorDate, e.clientX);
    showZoomHint();
  },
  { passive: false }
);

let zoomHintTimer = null;

function showZoomHint() {
  const el = $("zoom-hint");
  if (!el) return;
  const label = { day: "日", week: "週", month: "月" }[scale];
  el.textContent = `${label}刻度 ・ ${pxPerDay.toFixed(1)} px/天`;
  el.hidden = false;
  clearTimeout(zoomHintTimer);
  zoomHintTimer = setTimeout(() => (el.hidden = true), 1200);
}

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

  pxPerDay = loadZoom();
  scale = scaleForPx(pxPerDay);
  await loadHolidays(); // 要在第一次渲染前載入，底色帶與工作日才算得出來
  renderHolidayLegend();
  renderHolidayNotes();
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
