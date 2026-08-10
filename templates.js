/* 專案範本庫。範本用「相對週期」描述，建立專案時再依選定的起始日期換算成實際日期。 */

const TEMPLATE_PERIOD_DAYS = 14; // 原本的硬體排程是一期兩週

const PROJECT_TEMPLATES = [
  {
    id: "blank",
    name: "空白專案",
    summary: "四條空軌道，自己從頭排",
    build() {
      return {
        markers: [],
        tracks: [
          { key: "product", label: "產品", color: "orange", tasks: [] },
          { key: "packaging", label: "包裝", color: "slate", tasks: [] },
          { key: "certification", label: "認證", color: "rust", tasks: [] },
          { key: "marketing", label: "行銷素材", color: "olive", tasks: [] },
        ],
      };
    },
  },
  {
    id: "hardware",
    name: "硬體開發排程",
    summary: "Award → 1st lot ETD 共 16 週，四軌道 31 項任務與 8 個階段里程碑",
    build() {
      // s / e 沿用原本的「第幾期」寫法，讀起來對得上既有排程表；
      // 實際日期由 buildProjectFromTemplate 依起始日換算。
      const t = (title, s, e, extra) => Object.assign({ title, s, e }, extra || {});
      return {
        markers: [
          { label: "Award", period: 1 },
          { label: "TS", period: 3 },
          { label: "T0 / T1", period: 5 },
          { label: "Pre-NPI", period: 5, highlight: true },
          { label: "T2", period: 6 },
          { label: "NPI", period: 7, highlight: true },
          { label: "MP", period: 8 },
          { label: "1st lot ETD", period: 9 },
        ],
        tracks: [
          {
            key: "product",
            label: "產品",
            color: "orange",
            tasks: [
              t("DFM", 2, 3),
              t("Mock up", 2, 3),
              t("色板打樣 / 承認 (ID/CMF)", 3, 4),
              t("Tooling", 3, 4, {
                subtasks: [
                  { title: "模具報價 / 下單", done: false },
                  { title: "模具打樣", done: false },
                  { title: "試模 T1", done: false },
                  { title: "修模確認", done: false },
                ],
              }),
              t("修模", 4, 4),
              t("咬花", 5, 5),
              t("工件承認 (ID/CMF)", 5, 5),
              t("PVT生產", 6, 6),
              t("PVT全檢", 6, 7),
              t("QTR", 7, 7),
              t("鍍樣 (PM)", 7, 7),
              t("Sales & MR sample ETD", 8, 8),
            ],
          },
          {
            key: "packaging",
            label: "包裝",
            color: "slate",
            tasks: [
              t("包裝結構樣", 3, 3),
              t("製作 label", 3, 3),
              t("製作 QSG", 3, 3),
              t("Label 試刷", 6, 6),
              t("QSG, 彩盒, label, 包材簽樣", 7, 7),
            ],
          },
          {
            key: "certification",
            label: "認證",
            color: "rust",
            tasks: [
              t("認證開案", 3, 3),
              t("文件審查", 4, 4),
              t("送樣", 5, 5),
              t("認證測試 (4-6wks)", 5, 6),
              t("投件 (2wks)", 7, 7),
              t("取證", 8, 8),
            ],
          },
          {
            key: "marketing",
            label: "行銷素材",
            color: "olive",
            tasks: [
              t("MKT Kick off", 3, 3),
              t("Naming", 3, 3),
              t("網頁 layout", 4, 4),
              t("Wording", 4, 8),
              t("Photo Brief", 5, 5),
              t("拍攝", 6, 6),
              t("修圖", 6, 7),
              t("Sales Kit 產品照/網頁", 8, 8),
            ],
          },
        ],
      };
    },
  },
];

function getTemplate(id) {
  return PROJECT_TEMPLATES.find((t) => t.id === id) || PROJECT_TEMPLATES[0];
}

// 第 n 期的起點（n 從 1 起算）
function periodStart(start, n) {
  return addDays(start, (n - 1) * TEMPLATE_PERIOD_DAYS);
}

// 依範本與起始日期產生一份完整的 schemaVersion 3 專案資料
function buildProjectFromTemplate(templateId, name, description, startISO) {
  const spec = getTemplate(templateId).build();
  const start = parseISO(startISO) || mondayOf(today());

  return migrateProject({
    schemaVersion: SCHEMA_VERSION,
    project: { name, description },
    phaseMarkers: spec.markers.map((m) => ({
      label: m.label,
      date: toISO(periodStart(start, m.period)),
      highlight: !!m.highlight,
    })),
    tracks: spec.tracks.map((tr) => ({
      key: tr.key,
      label: tr.label,
      color: tr.color,
      tasks: tr.tasks.map((task) => ({
        title: task.title,
        start: toISO(periodStart(start, task.s)),
        // 第 e 期的最後一天 = 第 e+1 期起點的前一天
        end: toISO(addDays(periodStart(start, task.e + 1), -1)),
        status: "upcoming",
        owner: "",
        note: "",
        links: [],
        baseline: null,
        subtasks: task.subtasks || [],
      })),
    })),
  });
}
