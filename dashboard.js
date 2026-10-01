let indexData = { projects: [] };
let projectDataById = {};
let selectedTemplate = PROJECT_TEMPLATES[0].id;

function $(id) {
  return document.getElementById(id);
}

function slugify(str) {
  return (
    str
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9一-鿿]+/g, "-")
      .replace(/^-+|-+$/g, "") || `project-${Date.now()}`
  );
}

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

/* ---------- 載入 ---------- */

const PENDING_KEY = "gc-pending-project";

/* 剛建立的專案有兩種讀不到的情況，要分開處理：
   - 專案檔本身：Pages 上還不存在 → readRepoJson 會自動退回 API
   - index.json：檔案「存在但是舊的」，不會 404，所以退回機制救不到，
     列表會安靜地少一筆，看起來像建立失敗。
   因此建立成功時記一個待確認的 id，發現它不在靜態清單裡就改讀 API 版本。 */
async function loadIndex() {
  const { json } = await readRepoJson("projects/index.json");
  const pending = readPending();
  if (!pending) return json;

  const ids = (json.projects || []).map((p) => p.id);
  if (ids.includes(pending.id)) {
    sessionStorage.removeItem(PENDING_KEY); // Pages 已追上
    return json;
  }

  try {
    const fresh = await ghGetFile("projects/index.json");
    if (fresh.json) {
      setBanner(
        "pending",
        "info",
        `剛建立的專案「${escapeHtml(pending.name || pending.id)}」在 GitHub 上已經存在，
         但 GitHub Pages 還在重新發佈（約 1–2 分鐘）。清單暫時直接從 GitHub 讀取。`,
        [{ label: "知道了", run: () => dropBanner("pending") }]
      );
      return fresh.json;
    }
  } catch (e) {
    /* 讀不到就用靜態版本，至少其他專案還在 */
  }
  return json;
}

function readPending() {
  try {
    const p = JSON.parse(sessionStorage.getItem(PENDING_KEY) || "null");
    // 超過 10 分鐘還沒出現就別再查了，避免每次載入都多打一次 API
    if (!p || Date.now() - p.at > 10 * 60 * 1000) {
      sessionStorage.removeItem(PENDING_KEY);
      return null;
    }
    return p;
  } catch (e) {
    return null;
  }
}

// 單一專案讀取失敗不能拖垮整個列表
async function loadProject(id) {
  try {
    const { json, via } = await readRepoJson(`projects/${id}.json`);
    return { data: migrateProject(json), via };
  } catch (e) {
    return { error: e.message || "JSON 解析失敗" };
  }
}

/* ---------- 提醒 ---------- */

function computeReminders() {
  const out = [];
  indexData.projects.forEach((p) => {
    const entry = projectDataById[p.id];
    if (!entry || !entry.data) return;
    out.push(...projectReminders(p, entry.data));
  });
  out.sort((a, b) => a.due - b.due);
  return out;
}

function nearestDueByProject(reminders) {
  const map = {};
  reminders.forEach((r) => {
    if (!map[r.projectId]) map[r.projectId] = r;
  });
  return map;
}

function renderReminders(reminders) {
  const slot = $("reminders-slot");
  if (!reminders.length) {
    slot.innerHTML = `
      <div class="reminders">
        <div class="reminders-head"><h3>近期提醒</h3><span class="reminders-count">0</span></div>
        <div class="reminders-empty">目前沒有未完成且有結束日期的任務。</div>
      </div>`;
    return;
  }
  const shown = reminders.slice(0, 8);
  const rows = shown
    .map(
      (r) => `
      <a class="reminder-row" href="project.html?id=${encodeURIComponent(r.projectId)}">
        <span class="reminder-stripe ${r.severity}"></span>
        <span class="reminder-main">
          <div class="reminder-task">${escapeHtml(r.taskTitle)}${r.owner ? `<span class="owner-chip">${escapeHtml(r.owner)}</span>` : ""}</div>
          <div class="reminder-project">${escapeHtml(r.projectName)} ・ ${escapeHtml(r.trackLabel)}</div>
        </span>
        <span class="reminder-date">${formatDate(r.due)}</span>
        <span class="reminder-badge ${r.severity}">${badgeLabel(r.days)}</span>
      </a>`
    )
    .join("");
  const more =
    reminders.length > shown.length
      ? `<div class="reminders-empty">還有 ${reminders.length - shown.length} 項未顯示</div>`
      : "";
  const overdue = reminders.filter((r) => r.severity === "overdue").length;
  slot.innerHTML = `
    <div class="reminders">
      <div class="reminders-head">
        <h3>近期提醒</h3>
        <span class="reminders-count">${reminders.length} 項待辦${overdue ? ` ・ ${overdue} 項逾期` : ""}</span>
      </div>
      ${rows}${more}
    </div>`;
}

/* ---------- 專案卡片 ---------- */

function renderList(nearest) {
  const el = $("project-list");
  const projects = indexData.projects;
  if (!projects.length) {
    el.innerHTML = `<p class="empty">還沒有專案，點下方「+ 新增專案」建立第一個。</p>`;
    return;
  }
  el.innerHTML = projects
    .map((p) => {
      const entry = projectDataById[p.id] || {};
      if (entry.error) {
        return `
        <a class="project-card broken" href="project.html?id=${encodeURIComponent(p.id)}">
          <div class="project-card-name">${escapeHtml(p.name)}</div>
          <div class="project-card-desc bad">⚠ 資料讀取失敗：${escapeHtml(entry.error)}</div>
        </a>`;
      }
      const agg = aggregateProgress(allTasks(entry.data));
      const r = nearest[p.id];
      const dueHtml = r
        ? `<div class="card-due ${r.severity}"><span class="dot"></span>${escapeHtml(r.taskTitle)} · ${formatDate(r.due)}</div>`
        : "";
      return `
      <a class="project-card" href="project.html?id=${encodeURIComponent(p.id)}">
        <div class="project-card-name">${escapeHtml(p.name)}</div>
        <div class="project-card-desc">${escapeHtml(p.description || "")}</div>
        <div class="card-progress">
          <div class="progress-bar"><div class="progress-fill" style="width:${agg.pct}%"></div></div>
          <span class="progress-text">${agg.pct}% ・ ${agg.done}/${agg.total}</span>
        </div>
        ${dueHtml}
        <div class="card-updated" data-updated="${escapeHtml(p.id)}"></div>
      </a>`;
    })
    .join("");
}

// G2：每張卡片顯示最後更新者與時間
async function loadCardUpdates() {
  const slots = [...document.querySelectorAll("[data-updated]")];
  await Promise.all(
    slots.map(async (slot) => {
      try {
        const c = await ghLatestCommit(`projects/${slot.dataset.updated}.json`);
        if (!c) return;
        const when = c.date ? new Date(c.date) : null;
        slot.textContent = `${c.author}${when ? ` ・ ${formatDate(when)}` : ""} 更新`;
      } catch (e) {
        /* 讀不到就留白 */
      }
    })
  );
}

/* ---------- 新增專案（F3 + A5） ---------- */

function renderTemplateList() {
  $("template-list").innerHTML = PROJECT_TEMPLATES.map(
    (t) => `
    <label class="template-option${t.id === selectedTemplate ? " selected" : ""}">
      <input type="radio" name="template" value="${t.id}" ${t.id === selectedTemplate ? "checked" : ""} />
      <span class="template-name">${escapeHtml(t.name)}</span>
      <span class="template-summary">${escapeHtml(t.summary)}</span>
    </label>`
  ).join("");
  $("template-list")
    .querySelectorAll("input[name='template']")
    .forEach((el) =>
      el.addEventListener("change", () => {
        selectedTemplate = el.value;
        renderTemplateList();
      })
    );
}

function openNewModal() {
  $("new-modal").style.display = "flex";
  $("new-name").value = "";
  $("new-desc").value = "";
  $("new-start").value = toISO(mondayOf(today())); // 預設本週一，範本以週為單位展開
  $("new-name-error").style.display = "none";
  selectedTemplate = PROJECT_TEMPLATES[0].id;
  renderTemplateList();
  $("new-name").focus();
}

function closeNewModal() {
  $("new-modal").style.display = "none";
}

function showNameError(msg) {
  const el = $("new-name-error");
  el.textContent = msg;
  el.style.display = msg ? "block" : "none";
}

async function createProject() {
  const name = $("new-name").value.trim();
  const description = $("new-desc").value.trim();
  const startISO = $("new-start").value;
  if (!name) {
    showNameError("請填入專案名稱。");
    return;
  }
  if (!parseISO(startISO)) {
    showNameError("請選擇一個有效的排程起始日期。");
    return;
  }
  const id = slugify(name);

  // A5：舊版直接覆寫同名專案的檔案，資料會不見。這裡先擋掉。
  if (indexData.projects.some((p) => p.id === id)) {
    showNameError(`已經有一個專案的代號是「${id}」，請換一個名稱，否則會覆蓋既有專案。`);
    return;
  }

  const btn = $("new-create");
  btn.disabled = true;
  btn.textContent = "檢查中…";
  try {
    const existing = await ghGetFile(`projects/${id}.json`);
    if (!existing.missing) {
      showNameError(`GitHub 上已經有 projects/${id}.json，請換一個名稱以免覆蓋。`);
      return;
    }

    btn.textContent = "建立中…";
    const project = buildProjectFromTemplate(selectedTemplate, name, description, startISO);
    await ghPutFile(`projects/${id}.json`, project, null, `Create project: ${name}`);

    // 專案檔已建立；清單若寫入失敗要明確告知，不要留下看不見的孤兒檔（A8）
    try {
      const idx = await ghGetFile("projects/index.json");
      const current = idx.json || { projects: [] };
      current.projects.push({ id, name, description });
      await ghPutFile("projects/index.json", current, idx.sha, `Add project to index: ${name}`);
    } catch (e) {
      closeNewModal();
      setBanner(
        "orphan",
        "warn",
        `專案檔 <code>projects/${escapeHtml(id)}.json</code> 已建立，但寫入專案清單失敗（${escapeHtml(e.message)}）。
         它暫時不會出現在列表中，可以直接用連結開啟，或重新整理後再試一次。`,
        [
          { label: "直接開啟", run: () => (window.location.href = `project.html?id=${encodeURIComponent(id)}`) },
          { label: "知道了", run: () => dropBanner("orphan") },
        ]
      );
      return;
    }

    // 記下來：回到清單時若 Pages 還沒追上，要改讀 API 版本的 index
    try {
      sessionStorage.setItem(PENDING_KEY, JSON.stringify({ id, name, at: Date.now() }));
    } catch (e) {
      /* 存不進去不影響建立 */
    }
    window.location.href = `project.html?id=${encodeURIComponent(id)}`;
  } catch (e) {
    showNameError(`建立失敗：${e.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = "建立專案";
  }
}

/* ---------- 事件 ---------- */

$("token-btn").addEventListener("click", async () => {
  const current = getToken();
  const next = window.prompt(
    "貼上 GitHub Personal Access Token（留空並確定可清除已儲存的 token）：",
    current
  );
  if (next === null) return;
  setToken(next.trim());

  if (!next.trim()) {
    dropBanner("token");
    alert("Token 已清除");
    return;
  }

  // 存好之後立刻驗一次權限，不要等到使用者按儲存才發現不能寫
  setBanner("token", "info", "正在檢查 Token 權限…");
  const diag = await ghDiagnoseToken();
  setBanner("token", diag.ok ? "info" : "error", ghTokenFixHtml(diag), [
    { label: "知道了", run: () => dropBanner("token") },
  ]);
});

$("new-project-btn").addEventListener("click", openNewModal);
$("new-close").addEventListener("click", closeNewModal);
$("new-cancel").addEventListener("click", closeNewModal);
$("new-create").addEventListener("click", createProject);
$("new-name").addEventListener("input", () => showNameError(""));
$("new-modal").addEventListener("click", (e) => {
  if (e.target.id === "new-modal") closeNewModal();
});

/* ---------- 啟動 ---------- */

async function init() {
  try {
    indexData = await loadIndex();
    if (!Array.isArray(indexData.projects)) indexData.projects = [];
  } catch (e) {
    $("project-list").innerHTML = `<p class="empty">${escapeHtml(e.message)}</p>`;
    return;
  }

  const results = await Promise.all(indexData.projects.map((p) => loadProject(p.id)));
  projectDataById = {};
  indexData.projects.forEach((p, i) => (projectDataById[p.id] = results[i]));

  const broken = indexData.projects.filter((p) => projectDataById[p.id].error);
  if (broken.length) {
    setBanner(
      "broken",
      "warn",
      `有 ${broken.length} 個專案的資料讀不到或格式錯誤：${broken.map((b) => escapeHtml(b.name)).join("、")}。其他專案照常顯示。`,
      [{ label: "知道了", run: () => dropBanner("broken") }]
    );
  }

  const reminders = computeReminders();
  renderReminders(reminders);
  renderList(nearestDueByProject(reminders));
  loadCardUpdates();
  initDailyBoard(); // Daily Task 看板與專案清單各自獨立載入
}

init();
