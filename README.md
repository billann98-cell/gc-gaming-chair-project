# 專案排程追蹤（多專案 + 線上編輯）

多專案的甘特圖排程追蹤網站，發布在 GitHub Pages。每個專案是 `projects/` 底下的一個 JSON 檔案，透過瀏覽器直接呼叫 GitHub API 讀寫，不需要後端伺服器。

## 架構

- `index.html` + `dashboard.js`：專案列表首頁，含完成度、最後更新者、範本選擇
- `project.html` + `project.js`：單一專案的甘特圖 + 編輯面板
- `utils.js`：共用邏輯（日期解析、進度計算、驗證、資料遷移）。刻意不使用 DOM API，讓 GitHub Actions 的 Node 腳本能共用同一份到期日算法
- `config.js`：GitHub repo 設定與 API 呼叫
- `templates.js`：新增專案時可選的範本
- `projects/index.json`：所有專案的清單（id/name/description）
- `projects/<id>.json`：每個專案的排程資料
- `scripts/check-schedule.js` + `.github/workflows/schedule-reminder.yml`：定時排程提醒

## 本機預覽

```bash
powershell -ExecutionPolicy Bypass -File server.ps1
```

開瀏覽器到 `http://localhost:8080`。純瀏覽模式不需要 token。

## 發布到 GitHub Pages

1. Repo 設為 **Public**（Settings → General → Danger Zone → Change visibility）
2. Settings → Pages → Source 選 `Deploy from a branch`，Branch 選 `main` / `root`
3. 幾分鐘後可透過 `https://billann98-cell.github.io/gc-gaming-chair-project/` 存取

## 編輯（新增/修改專案）

編輯功能需要一個 GitHub **Personal Access Token**：

1. 到 github.com → 頭像 → Settings → Developer settings → Personal access tokens → Fine-grained tokens
2. 建立 token，**Repository access** 只選這個 repo (`gc-gaming-chair-project`)，**Permissions → Contents** 設為 `Read and write`。建議一併設定到期日
3. 在網站上點右上角「🔑 GitHub Token」貼上，之後就存在瀏覽器本機（`localStorage`），不會上傳到任何地方
4. 之後點「+ 新增專案」或進入專案點「✏️ 編輯」→「儲存到 GitHub」都會用這個 token 直接對 repo 建立 commit

**注意**：這個 token 等於是你這個 repo 的寫入密碼，請不要分享給別人、不要在公用電腦上貼、也不要貼到其他網站。若懷疑外流，到 GitHub token 設定頁面刪除即可。

### 衝突保護

點「✏️ 編輯」時會先向 GitHub API 取得檔案的最新內容與 `sha`（不是讀 Pages 的靜態檔，因為那會有 CDN 快取延遲）。儲存時把這個 `sha` 帶回去，如果期間有其他人改過同一個檔案，GitHub 會擋下來並提示你重新載入，而不是靜默覆蓋對方的變更。

若進入編輯時無法連上 GitHub，畫面會出現警告，並且該次不允許儲存。

## 資料格式（schemaVersion 2）

舊版資料開啟時會自動遷移，不需手動轉換。

```json
{
  "schemaVersion": 2,
  "project": { "name": "專案名稱", "description": "說明", "baselineCapturedAt": "2026-08-10" },
  "periods": [{ "index": 1, "date": "2026-06-15" }],
  "phaseMarkers": [{ "label": "Award", "line": 1, "highlight": false }],
  "tracks": [
    {
      "key": "product",
      "label": "產品",
      "color": "orange",
      "tasks": [
        {
          "title": "任務名稱",
          "start": 1,
          "end": 3,
          "status": "upcoming",
          "owner": "王小明",
          "note": "備註",
          "links": [{ "label": "規格書", "url": "https://..." }],
          "baseline": { "start": 1, "end": 3 },
          "subtasks": [{ "title": "細項", "done": false }]
        }
      ]
    }
  ]
}
```

- `periods[].date`：**必須是 `YYYY-MM-DD`**。網站上是日期選擇器，不會讓你打錯。舊資料若是 `8/15`、`W32` 這種無法確定的寫法，會被保留在 `dateLegacy` 並在編輯面板標紅要求重填 —— 刻意不猜測，因為猜錯會算出錯誤的到期日
- `start` / `end`：對應 `periods` 的第幾個區間（1 起算），`end` 不得小於 `start`
- `status`：`upcoming`（待辦）/ `in-progress`（進行中）/ `done`（已完成）
- `baseline`：基準線，用來對比排程延後了幾期／幾天。設為 `null` 表示沒有基準線

## 功能說明

**甘特圖**
- 期間填入日期後會顯示**今天線**，開頁時自動捲到今天的位置
- 完成度：整個專案、每條軌道、每個任務各自顯示（有細項時依細項完成比例計算）
- 基準線對比：右上角「📏 基準線」切換顯示，延後的任務會標出延後幾期與幾天
- 滑鼠移到長條上會顯示完整資訊（名稱、日期、負責人、備註、基準線差異）

**編輯**
- 在甘特圖上**直接拖曳長條**移動位置，拖兩端可改長度，會自動吸附到期間格線
- 期間可增減；刪除期間前會提示會影響幾個任務與里程碑
- 批次調整：可把整條軌道或全部任務一次往後／往前位移數期，期間不足時自動增加
- 「取消編輯」會完整還原到進入編輯前的狀態；有未儲存變更時關閉分頁會被攔下，並在本機留下草稿，下次開啟可選擇恢復

**從 Excel 匯入**
編輯面板 →「📋 從 Excel 貼上匯入」。在 Excel 選取範圍複製後直接貼上，欄位順序：

| 軌道 | 任務名稱 | 開始期間 | 結束期間 | 狀態 | 負責人 | 備註 |
|---|---|---|---|---|---|---|
| 產品 | 椅腳強度測試 | 3 | 4 | 進行中 | 王小明 | 含滾輪 |

第一列可以是標題列。軌道不存在時會自動建立；期間不足時可自動增加。貼上後會先顯示預覽與問題清單，確認後才寫入。

**列印 / PDF**
右上角「🖨️ 列印」。已設定 A4 橫向的列印樣式，會隱藏按鈕與編輯面板、強制白底黑字（深色模式也一樣），適合貼進 review 簡報。

## 定時排程提醒（GitHub Actions）

網站上的「近期提醒」只有打開網頁才看得到。`.github/workflows/schedule-reminder.yml` 讓提醒主動送出來：

- 每週一至五台北時間 09:00 執行，也可以到 Actions 頁面手動觸發（可指定「幾天內到期」）
- 掃描所有專案的逾期與近期到期任務，結果寫進 Actions 執行摘要
- 並且維護一張帶 `schedule-reminder` 標籤的 GitHub Issue，內容每次更新。**這步用內建的 `GITHUB_TOKEN`，不需要任何額外設定**
- 若想推到 Teams / Slack / Google Chat：到 Settings → Secrets and variables → Actions 新增一個名為 `WEBHOOK_URL` 的 secret，填入該平台的 incoming webhook 網址即可

到期日的算法與網站共用 `utils.js`，不會出現「網站說還有三天、提醒說已逾期」的不一致。

**注意**：GitHub 會在 repo 連續 60 天沒有任何活動後自動停用排程 workflow，屆時到 Actions 頁面點一下重新啟用即可。

## 已知限制

- **GitHub API 額度**：沒有設定 token 時，每個 IP 每小時只有 60 次 API 額度。「最後更新者」欄位會用掉一部分，因此結果會在瀏覽器 sessionStorage 快取 5 分鐘。若整間辦公室共用同一個對外 IP 又沒設 token，這個欄位可能偶爾空白（不影響排程本身的顯示與編輯）
- **手機版尚未完整支援**：甘特圖可以橫向滑動，對話框與批次工具在窄畫面已可操作，但編輯面板整體還沒針對手機重新排版
- **軌道顏色的對比度**：`orange`、`slate`、`olive` 三色配白字未達 WCAG AA 標準，深色模式下也未針對軌道色調整
- **專案名稱、軌道、階段里程碑仍需改 JSON**：網頁上還不能改專案名稱與說明、不能新增／刪除／改名軌道（匯入時會自動建立新軌道）、不能編輯階段里程碑
- **排程精度以「期間」為單位**：任務位置是第幾期，不是實際起訖日期。因此基準線對比是「延後幾期」，天數是依期間日期換算而來的
