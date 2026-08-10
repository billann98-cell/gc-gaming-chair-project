/* F3：專案範本庫。新增專案時可挑選，省去每次從零建立軌道與里程碑。 */

const PROJECT_TEMPLATES = [
  {
    id: "blank",
    name: "空白專案",
    summary: "8 個期間、四條空軌道，自己從頭排",
    build() {
      return {
        periods: 8,
        phaseMarkers: [],
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
    summary: "Award → 1st lot ETD 完整 8 期範本，含四軌道 31 項任務與階段里程碑",
    build() {
      const t = (title, start, end, extra) =>
        Object.assign({ title, start, end, status: "upcoming" }, extra || {});
      return {
        periods: 8,
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

// 依範本產生一份完整的專案資料（已經是 schemaVersion 2 的形狀）
function buildProjectFromTemplate(templateId, name, description) {
  const spec = getTemplate(templateId).build();
  return migrateProject({
    project: { name, description },
    periods: Array.from({ length: spec.periods }, (_, i) => ({ index: i + 1, date: "" })),
    phaseMarkers: spec.phaseMarkers,
    tracks: spec.tracks,
  });
}
