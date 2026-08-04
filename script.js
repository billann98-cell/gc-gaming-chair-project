const STATUS_LABEL = {
  done: "已完成",
  "in-progress": "進行中",
  upcoming: "待辦",
};

async function loadData() {
  const res = await fetch("data.json");
  return res.json();
}

function renderProject(project) {
  document.getElementById("project-name").textContent = project.name;
  document.getElementById("project-desc").textContent = project.description;
}

function renderProgress(milestones) {
  const done = milestones.filter((m) => m.status === "done").length;
  const pct = milestones.length ? Math.round((done / milestones.length) * 100) : 0;
  document.getElementById("progress-count").textContent = `${done} / ${milestones.length} 完成`;
  document.getElementById("progress-pct").textContent = `${pct}%`;
  document.getElementById("progress-fill").style.width = `${pct}%`;
}

function renderMilestones(milestones) {
  const sorted = [...milestones].sort((a, b) => new Date(a.date) - new Date(b.date));
  const timeline = document.getElementById("timeline");
  timeline.innerHTML = sorted
    .map(
      (m) => `
      <div class="milestone" data-status="${m.status}">
        <div class="milestone-card">
          <div class="milestone-header">
            <span class="milestone-title">${escapeHtml(m.title)}</span>
            <span class="milestone-date">${m.date}</span>
          </div>
          <div class="milestone-desc">${escapeHtml(m.description || "")}</div>
          <span class="badge" data-status="${m.status}">${STATUS_LABEL[m.status] || m.status}</span>
        </div>
      </div>`
    )
    .join("");
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

loadData().then(({ project, milestones }) => {
  renderProject(project);
  renderProgress(milestones);
  renderMilestones(milestones);
});
