/* G1：定時排程檢查。
   由 .github/workflows/schedule-reminder.yml 觸發，掃描所有專案的逾期與近期到期任務。

   輸出（由外到內，越後面越需要設定）：
   1. Actions 的執行摘要（永遠會有）
   2. 更新一張帶 schedule-reminder 標籤的 GitHub Issue（用內建 GITHUB_TOKEN，不需額外設定）
   3. 若設定了 WEBHOOK_URL secret，額外 POST 一份到 Teams / Slack / Google Chat

   刻意共用 utils.js 的到期日邏輯，避免和網站算出不同結果。 */

const fs = require("fs");
const path = require("path");
const { projectReminders, migrateProject, formatDate, badgeLabel } = require("../utils.js");

const ROOT = path.join(__dirname, "..");
const DUE_DAYS = Number(process.env.DUE_DAYS || 7);
const REPO = process.env.REPO || "";
const TOKEN = process.env.GITHUB_TOKEN || "";
const WEBHOOK_URL = process.env.WEBHOOK_URL || "";
const ISSUE_TITLE = "📅 排程提醒：逾期與近期到期任務";
const ISSUE_LABEL = "schedule-reminder";

function readJson(relPath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relPath), "utf8"));
}

function collect() {
  let index;
  try {
    index = readJson("projects/index.json");
  } catch (e) {
    console.error(`讀取 projects/index.json 失敗：${e.message}`);
    return { items: [], skipped: [] };
  }

  const items = [];
  const skipped = [];
  (index.projects || []).forEach((meta) => {
    try {
      const data = migrateProject(readJson(`projects/${meta.id}.json`));
      items.push(...projectReminders(meta, data));
    } catch (e) {
      skipped.push(`${meta.id}（${e.message}）`);
    }
  });

  const relevant = items.filter((r) => r.days <= DUE_DAYS);
  relevant.sort((a, b) => a.days - b.days);
  return { items: relevant, skipped };
}

function buildMarkdown(items, skipped) {
  if (!items.length) {
    let md = `## ${ISSUE_TITLE}\n\n目前沒有逾期，也沒有 ${DUE_DAYS} 天內到期的未完成任務。 ✅\n`;
    if (skipped.length) md += `\n> ⚠ 有 ${skipped.length} 個專案無法讀取：${skipped.join("、")}\n`;
    return md;
  }

  const overdue = items.filter((r) => r.days < 0);
  const soon = items.filter((r) => r.days >= 0);

  const row = (r) =>
    `| ${r.projectName} | ${r.trackLabel} | ${r.taskTitle} | ${r.owner || "—"} | ${formatDate(r.due)} | ${badgeLabel(r.days)} |`;
  const table = (rows) =>
    ["| 專案 | 軌道 | 任務 | 負責人 | 到期日 | 狀態 |", "| --- | --- | --- | --- | --- | --- |", ...rows.map(row)].join("\n");

  let md = `## ${ISSUE_TITLE}\n\n共 ${items.length} 項需要注意（逾期 ${overdue.length} 項、${DUE_DAYS} 天內到期 ${soon.length} 項）。\n`;
  if (overdue.length) md += `\n### 🔴 已逾期\n\n${table(overdue)}\n`;
  if (soon.length) md += `\n### 🟡 ${DUE_DAYS} 天內到期\n\n${table(soon)}\n`;
  if (skipped.length) md += `\n> ⚠ 有 ${skipped.length} 個專案無法讀取：${skipped.join("、")}\n`;
  md += `\n<sub>由 GitHub Actions 自動更新。到期日是依各任務「結束期間」對應的日期推算。</sub>\n`;
  return md;
}

async function gh(pathname, options) {
  const res = await fetch(`https://api.github.com${pathname}`, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      ...(options && options.headers),
    },
  });
  if (!res.ok) {
    throw new Error(`${options && options.method ? options.method : "GET"} ${pathname} → ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function upsertIssue(body, hasItems) {
  if (!TOKEN || !REPO) {
    console.log("沒有 GITHUB_TOKEN 或 REPO，略過 Issue 更新。");
    return;
  }
  const open = await gh(`/repos/${REPO}/issues?state=open&labels=${ISSUE_LABEL}&per_page=1`);
  const existing = Array.isArray(open) && open.length ? open[0] : null;

  if (existing) {
    await gh(`/repos/${REPO}/issues/${existing.number}`, {
      method: "PATCH",
      body: JSON.stringify({ title: ISSUE_TITLE, body }),
    });
    console.log(`已更新 Issue #${existing.number}`);
    return;
  }
  if (!hasItems) {
    console.log("沒有需要提醒的項目，也沒有既有 Issue，不建立新的。");
    return;
  }
  const created = await gh(`/repos/${REPO}/issues`, {
    method: "POST",
    body: JSON.stringify({ title: ISSUE_TITLE, body, labels: [ISSUE_LABEL] }),
  });
  console.log(`已建立 Issue #${created.number}`);
}

async function postWebhook(text) {
  if (!WEBHOOK_URL) return;
  try {
    const res = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    console.log(`Webhook 回應 ${res.status}`);
  } catch (e) {
    console.error(`Webhook 推送失敗：${e.message}`);
  }
}

async function main() {
  const { items, skipped } = collect();
  const md = buildMarkdown(items, skipped);
  console.log(md);

  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  }

  try {
    await upsertIssue(md, items.length > 0);
  } catch (e) {
    console.error(`Issue 更新失敗：${e.message}`);
  }

  if (items.length) await postWebhook(md);
}

// 提醒失敗不應該讓整個 workflow 變紅，記錄下來就好
main().catch((e) => {
  console.error(e);
});
