function slugify(str) {
  return str
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿]+/g, "-")
    .replace(/^-+|-+$/g, "") || `project-${Date.now()}`;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

async function loadIndex() {
  const res = await fetch(`projects/index.json?_=${Date.now()}`);
  if (!res.ok) throw new Error("讀取專案清單失敗");
  return res.json();
}

async function loadProject(id) {
  const res = await fetch(`projects/${id}.json?_=${Date.now()}`);
  if (!res.ok) return null;
  return res.json();
}

function parseDueDate(str) {
  if (!str) return null;
  const s = str.trim();
  if (!s) return null;
  const m = s.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function dayDiff(due, now) {
  const a = new Date(due.getFullYear(), due.getMonth(), due.getDate());
  const b = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((a - b) / 86400000);
}

function formatDate(d) {
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
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

function computeReminders(projects, projectDataById) {
  const out = [];
  projects.forEach((p) => {
    const proj = projectDataById[p.id];
    if (!proj) return;
    proj.tracks.forEach((track) => {
      track.tasks.forEach((task) => {
        if (task.status === "done") return;
        const period = proj.periods[task.end - 1];
        const due = period && parseDueDate(period.date);
        if (!due) return;
        out.push({ projectId: p.id, projectName: p.name, taskTitle: task.title, due });
      });
    });
  });
  const now = new Date();
  out.forEach((r) => {
    r.days = dayDiff(r.due, now);
    r.severity = severityFor(r.days);
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
  const slot = document.getElementById("reminders-slot");
  if (!reminders.length) {
    slot.innerHTML = `
      <div class="reminders">
        <div class="reminders-head"><h3>近期提醒</h3><span class="reminders-count">0</span></div>
        <div class="reminders-empty">目前沒有設定日期的待辦項目 — 到專案的「編輯」填入 Period 日期後會顯示在這裡。</div>
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
          <div class="reminder-task">${escapeHtml(r.taskTitle)}</div>
          <div class="reminder-project">${escapeHtml(r.projectName)}</div>
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
  slot.innerHTML = `
    <div class="reminders">
      <div class="reminders-head"><h3>近期提醒</h3><span class="reminders-count">${reminders.length} 項待辦</span></div>
      ${rows}${more}
    </div>`;
}

function renderList(projects, nearest) {
  const el = document.getElementById("project-list");
  if (!projects.length) {
    el.innerHTML = `<p class="empty">還沒有專案，點下方「+ 新增專案」建立第一個。</p>`;
    return;
  }
  el.innerHTML = projects
    .map((p) => {
      const r = nearest[p.id];
      const dueHtml = r
        ? `<div class="card-due ${r.severity}"><span class="dot"></span>${escapeHtml(r.taskTitle)} · ${formatDate(r.due)}</div>`
        : "";
      return `
      <a class="project-card" href="project.html?id=${encodeURIComponent(p.id)}">
        <div class="project-card-name">${escapeHtml(p.name)}</div>
        <div class="project-card-desc">${escapeHtml(p.description || "")}</div>
        ${dueHtml}
      </a>`;
    })
    .join("");
}

async function init() {
  try {
    const { projects } = await loadIndex();
    const projectDatas = await Promise.all(projects.map((p) => loadProject(p.id)));
    const projectDataById = {};
    projects.forEach((p, i) => {
      projectDataById[p.id] = projectDatas[i];
    });
    const reminders = computeReminders(projects, projectDataById);
    renderReminders(reminders);
    renderList(projects, nearestDueByProject(reminders));
  } catch (e) {
    document.getElementById("project-list").innerHTML = `<p class="empty">${escapeHtml(e.message)}</p>`;
  }
}

document.getElementById("token-btn").addEventListener("click", () => {
  const current = getToken();
  const next = window.prompt(
    "貼上 GitHub Personal Access Token（留空並確定可清除已儲存的 token）：",
    current
  );
  if (next === null) return;
  setToken(next.trim());
  alert(next.trim() ? "Token 已儲存於本機瀏覽器" : "Token 已清除");
});

document.getElementById("new-project-btn").addEventListener("click", async () => {
  const name = window.prompt("新專案名稱：");
  if (!name) return;
  const description = window.prompt("專案說明（可留空）：") || "";
  const id = slugify(name);

  const template = {
    project: { name, description },
    periods: Array.from({ length: 8 }, (_, i) => ({ index: i + 1, date: "" })),
    phaseMarkers: [
      { label: "Award", line: 1 },
      { label: "TS", line: 3 },
      { label: "T0 / T1", line: 5 },
      { label: "Pre-NPI", line: 5, highlight: true },
      { label: "T2", line: 6 },
      { label: "NPI", line: 7, highlight: true },
      { label: "MP", line: 8 },
      { label: "1st lot ETD", line: 9 },
    ],
    tracks: [
      { key: "product", label: "產品", color: "orange", tasks: [] },
      { key: "packaging", label: "包裝", color: "slate", tasks: [] },
      { key: "certification", label: "認證", color: "rust", tasks: [] },
      { key: "marketing", label: "行銷素材", color: "olive", tasks: [] },
    ],
  };

  const btn = document.getElementById("new-project-btn");
  btn.disabled = true;
  btn.textContent = "建立中...";
  try {
    await saveJsonFile(`projects/${id}.json`, template, `Create project: ${name}`);
    const current = await loadIndex();
    current.projects.push({ id, name, description });
    await saveJsonFile("projects/index.json", current, `Add project to index: ${name}`);
    window.location.href = `project.html?id=${encodeURIComponent(id)}`;
  } catch (e) {
    alert(`建立失敗：${e.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = "+ 新增專案";
  }
});

init();
