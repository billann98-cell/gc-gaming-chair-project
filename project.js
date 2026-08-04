const params = new URLSearchParams(window.location.search);
const projectId = params.get("id");
const filePath = `projects/${projectId}.json`;
let data = null;
let editMode = false;

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function markerLeftPercent(line, n) {
  return ((line - 1) / n) * 100;
}

function renderGantt() {
  const { project, periods, phaseMarkers, tracks } = data;
  document.getElementById("project-name").textContent = project.name;
  document.getElementById("project-desc").textContent = project.description || "";
  document.getElementById("project-file-path").textContent = filePath;

  const n = periods.length;

  const periodRow = document.getElementById("period-row");
  periodRow.style.setProperty("--n", n);
  periodRow.innerHTML = periods
    .map((p) => `<div class="period-cell">${p.index}<span class="period-date">${escapeHtml(p.date || "")}</span></div>`)
    .join("");

  const markerRow = document.getElementById("marker-row");
  markerRow.innerHTML = phaseMarkers
    .map((m, i) => {
      const left = markerLeftPercent(m.line, n);
      const edge = i === 0 ? "first" : i === phaseMarkers.length - 1 ? "last" : "mid";
      const type = m.highlight ? "highlight" : "normal";
      return `<div class="marker ${type}" data-edge="${edge}" style="left:${left}%">${escapeHtml(m.label)}</div>`;
    })
    .join("");

  const markerLines = document.getElementById("marker-lines");
  markerLines.innerHTML = phaseMarkers
    .map((m) => `<div class="marker-line${m.highlight ? " highlight" : ""}" style="left:${markerLeftPercent(m.line, n)}%"></div>`)
    .join("");

  const bodyEl = document.getElementById("gantt-body");
  const labelCol = document.createElement("div");
  labelCol.className = "track-label-col";
  const taskCol = document.createElement("div");
  taskCol.style.gridColumn = "2";

  tracks.forEach((track) => {
    const trackBlock = document.createElement("div");
    trackBlock.className = "track-block";
    const title = document.createElement("div");
    title.className = "track-title";
    title.dataset.color = track.color;
    title.textContent = track.label;
    trackBlock.appendChild(title);
    track.tasks.forEach(() => {
      const spacer = document.createElement("div");
      spacer.style.minHeight = "34px";
      trackBlock.appendChild(spacer);
    });
    labelCol.appendChild(trackBlock);

    const taskRows = document.createElement("div");
    taskRows.className = "task-rows";
    taskRows.style.setProperty("--n", n);
    const headerSpacer = document.createElement("div");
    headerSpacer.style.minHeight = "34px";
    taskRows.appendChild(headerSpacer);

    track.tasks.forEach((task) => {
      const row = document.createElement("div");
      row.className = "task-row";
      row.style.setProperty("--n", n);
      const bar = document.createElement("div");
      bar.className = "task-bar";
      bar.dataset.color = track.color;
      bar.dataset.status = task.status;
      bar.style.gridColumnStart = String(task.start);
      bar.style.gridColumnEnd = String(task.end + 1);
      const subs = task.subtasks || [];
      if (subs.length) {
        const doneN = subs.filter((s) => s.done).length;
        bar.innerHTML = `${escapeHtml(task.title)}<span class="subtask-progress">(${doneN}/${subs.length})</span>`;
      } else {
        bar.textContent = task.title;
      }
      row.appendChild(bar);
      taskRows.appendChild(row);
    });
    taskCol.appendChild(taskRows);
  });

  bodyEl.innerHTML = "";
  bodyEl.appendChild(labelCol);
  bodyEl.appendChild(taskCol);
}

function renderEditPanel() {
  const panel = document.getElementById("edit-panel");
  if (!editMode) {
    panel.style.display = "none";
    panel.innerHTML = "";
    return;
  }
  panel.style.display = "block";

  const periodsHtml = data.periods
    .map(
      (p, i) => `
      <label class="field-inline">
        Period ${p.index}
        <input type="text" data-kind="period-date" data-index="${i}" value="${escapeHtml(p.date || "")}" placeholder="日期" />
      </label>`
    )
    .join("");

  const tracksHtml = data.tracks
    .map((track, ti) => {
      const rows = track.tasks
        .map((task, tj) => {
          const subs = task.subtasks || [];
          const doneN = subs.filter((s) => s.done).length;
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
          return `
        <div class="task-edit-item">
          <div class="task-edit-row">
            <input type="text" data-kind="task-title" data-track="${ti}" data-task="${tj}" value="${escapeHtml(task.title)}" placeholder="任務名稱" />
            <input type="number" min="1" max="${data.periods.length}" data-kind="task-start" data-track="${ti}" data-task="${tj}" value="${task.start}" />
            <span>~</span>
            <input type="number" min="1" max="${data.periods.length}" data-kind="task-end" data-track="${ti}" data-task="${tj}" value="${task.end}" />
            <select data-kind="task-status" data-track="${ti}" data-task="${tj}">
              <option value="upcoming" ${task.status === "upcoming" ? "selected" : ""}>待辦</option>
              <option value="in-progress" ${task.status === "in-progress" ? "selected" : ""}>進行中</option>
              <option value="done" ${task.status === "done" ? "selected" : ""}>已完成</option>
            </select>
            <button class="btn-remove" data-kind="task-remove" data-track="${ti}" data-task="${tj}">刪除</button>
          </div>
          <details class="subtask-details" ${subs.length ? "open" : ""}>
            <summary>細項 ${doneN}/${subs.length}</summary>
            <div class="subtask-list">
              ${subRows}
              <button class="btn-secondary btn-add-subtask" data-kind="subtask-add" data-track="${ti}" data-task="${tj}">+ 新增細項</button>
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
    <h3>期間日期</h3>
    <div class="period-edit-grid">${periodsHtml}</div>
    <h3>任務</h3>
    ${tracksHtml}
  `;

  panel.querySelectorAll("[data-kind='period-date']").forEach((el) =>
    el.addEventListener("input", (e) => {
      data.periods[+e.target.dataset.index].date = e.target.value;
      renderGantt();
    })
  );

  panel.querySelectorAll("[data-kind='task-title']").forEach((el) =>
    el.addEventListener("input", (e) => {
      data.tracks[+e.target.dataset.track].tasks[+e.target.dataset.task].title = e.target.value;
      renderGantt();
    })
  );
  panel.querySelectorAll("[data-kind='task-start']").forEach((el) =>
    el.addEventListener("input", (e) => {
      data.tracks[+e.target.dataset.track].tasks[+e.target.dataset.task].start = +e.target.value;
      renderGantt();
    })
  );
  panel.querySelectorAll("[data-kind='task-end']").forEach((el) =>
    el.addEventListener("input", (e) => {
      data.tracks[+e.target.dataset.track].tasks[+e.target.dataset.task].end = +e.target.value;
      renderGantt();
    })
  );
  panel.querySelectorAll("[data-kind='task-status']").forEach((el) =>
    el.addEventListener("change", (e) => {
      data.tracks[+e.target.dataset.track].tasks[+e.target.dataset.task].status = e.target.value;
      renderGantt();
    })
  );
  panel.querySelectorAll("[data-kind='task-remove']").forEach((el) =>
    el.addEventListener("click", (e) => {
      const ti = +e.target.dataset.track;
      const tj = +e.target.dataset.task;
      data.tracks[ti].tasks.splice(tj, 1);
      renderGantt();
      renderEditPanel();
    })
  );
  panel.querySelectorAll("[data-kind='task-add']").forEach((el) =>
    el.addEventListener("click", (e) => {
      const ti = +e.target.dataset.track;
      data.tracks[ti].tasks.push({ title: "新任務", start: 1, end: 1, status: "upcoming", subtasks: [] });
      renderGantt();
      renderEditPanel();
    })
  );

  panel.querySelectorAll("[data-kind='subtask-done']").forEach((el) =>
    el.addEventListener("change", (e) => {
      const ti = +e.target.dataset.track, tj = +e.target.dataset.task, sj = +e.target.dataset.sub;
      data.tracks[ti].tasks[tj].subtasks[sj].done = e.target.checked;
      renderGantt();
      renderEditPanel();
    })
  );
  panel.querySelectorAll("[data-kind='subtask-title']").forEach((el) =>
    el.addEventListener("input", (e) => {
      const ti = +e.target.dataset.track, tj = +e.target.dataset.task, sj = +e.target.dataset.sub;
      data.tracks[ti].tasks[tj].subtasks[sj].title = e.target.value;
    })
  );
  panel.querySelectorAll("[data-kind='subtask-remove']").forEach((el) =>
    el.addEventListener("click", (e) => {
      const ti = +e.target.dataset.track, tj = +e.target.dataset.task, sj = +e.target.dataset.sub;
      data.tracks[ti].tasks[tj].subtasks.splice(sj, 1);
      renderGantt();
      renderEditPanel();
    })
  );
  panel.querySelectorAll("[data-kind='subtask-add']").forEach((el) =>
    el.addEventListener("click", (e) => {
      const ti = +e.target.dataset.track, tj = +e.target.dataset.task;
      const task = data.tracks[ti].tasks[tj];
      if (!task.subtasks) task.subtasks = [];
      task.subtasks.push({ title: "新細項", done: false });
      renderGantt();
      renderEditPanel();
    })
  );
}

document.getElementById("edit-toggle-btn").addEventListener("click", () => {
  editMode = !editMode;
  document.getElementById("edit-toggle-btn").textContent = editMode ? "取消編輯" : "✏️ 編輯";
  document.getElementById("save-btn").style.display = editMode ? "inline-block" : "none";
  renderEditPanel();
});

document.getElementById("save-btn").addEventListener("click", async () => {
  const btn = document.getElementById("save-btn");
  btn.disabled = true;
  btn.textContent = "儲存中...";
  try {
    await saveJsonFile(filePath, data, `Update project: ${data.project.name}`);
    btn.textContent = "已儲存 ✓";
    setTimeout(() => (btn.textContent = "儲存到 GitHub"), 2000);
  } catch (e) {
    alert(`儲存失敗：${e.message}`);
    btn.textContent = "儲存到 GitHub";
  } finally {
    btn.disabled = false;
  }
});

async function init() {
  if (!projectId) {
    document.body.innerHTML = `<p style="padding:40px;">缺少專案 id，請從<a href="index.html">專案列表</a>進入。</p>`;
    return;
  }
  const res = await fetch(`${filePath}?_=${Date.now()}`);
  if (!res.ok) {
    document.body.innerHTML = `<p style="padding:40px;">找不到專案「${escapeHtml(projectId)}」。</p>`;
    return;
  }
  data = await res.json();
  renderGantt();
}

init();
