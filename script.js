async function loadData() {
  const res = await fetch("data.json");
  return res.json();
}

function renderProject(project) {
  document.getElementById("project-name").textContent = project.name;
  document.getElementById("project-desc").textContent = project.description;
}

function markerLeftPercent(line, n) {
  return ((line - 1) / n) * 100;
}

function render({ project, periods, phaseMarkers, tracks }) {
  renderProject(project);

  const n = periods.length;
  const root = document.documentElement;
  document.querySelectorAll(".period-row, .task-row").forEach((el) => {
    el.style.setProperty("--n", n);
  });

  const periodRow = document.getElementById("period-row");
  periodRow.style.setProperty("--n", n);
  periodRow.innerHTML = periods
    .map(
      (p) => `
      <div class="period-cell">
        ${p.index}
        <span class="period-date">${p.date || ""}</span>
      </div>`
    )
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
    .map((m) => {
      const left = markerLeftPercent(m.line, n);
      return `<div class="marker-line${m.highlight ? " highlight" : ""}" style="left:${left}%"></div>`;
    })
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
    const trackHeaderSpacer = document.createElement("div");
    trackHeaderSpacer.style.minHeight = "34px";
    taskRows.appendChild(trackHeaderSpacer);

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
      bar.textContent = task.title;
      row.appendChild(bar);
      taskRows.appendChild(row);
    });
    taskCol.appendChild(taskRows);
  });

  bodyEl.innerHTML = "";
  bodyEl.appendChild(labelCol);
  bodyEl.appendChild(taskCol);
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

loadData().then(render);
