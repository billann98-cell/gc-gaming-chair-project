# 專案排程追蹤（多專案 + 線上編輯）

多專案的甘特圖排程追蹤網站，發布在 GitHub Pages。每個專案是 `projects/` 底下的一個 JSON 檔案，透過瀏覽器直接呼叫 GitHub API 讀寫，不需要後端伺服器。

排程以**實際日期**為基準：任務存起訖日期，時間軸是真正的日曆（可切換週／月刻度），階段里程碑綁定日期。

## 架構

- `index.html` + `dashboard.js`：專案列表首頁，含完成度、最後更新者、範本選擇
- `project.html` + `project.js`：單一專案的甘特圖 + 編輯面板
- `utils.js`：共用邏輯（日期解析、時間軸計算、進度、驗證、資料遷移）。刻意不使用 DOM API，讓 GitHub Actions 的 Node 腳本能 require 同一份到期日算法
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

## 資料格式（schemaVersion 3）

```json
{
  "schemaVersion": 3,
  "project": { "name": "專案名稱", "description": "說明", "baselineCapturedAt": "2026-08-10" },
  "phaseMarkers": [
    { "label": "Award", "date": "2026-06-15", "highlight": false },
    { "label": "NPI", "date": "2026-09-07", "highlight": true }
  ],
  "tracks": [
    {
      "key": "product",
      "label": "產品",
      "color": "orange",
      "tasks": [
        {
          "title": "任務名稱",
          "start": "2026-06-15",
          "end": "2026-07-03",
          "status": "upcoming",
          "owner": "王小明",
          "note": "備註",
          "links": [{ "label": "規格書", "url": "https://..." }],
          "baseline": { "start": "2026-06-15", "end": "2026-07-03" },
          "subtasks": [{ "title": "細項", "done": false }]
        }
      ]
    }
  ]
}
```

- 所有日期都是 **`YYYY-MM-DD`**。網站上用日期選擇器，不會讓你打錯
- `start` / `end`：任務的實際起訖日，**含頭含尾**（6/15~6/15 表示一天）。`end` 不得早於 `start`
- `status`：`upcoming`（待辦）/ `in-progress`（進行中）/ `done`（已完成）
- `phaseMarkers[].date`：里程碑綁定的日期，垂直線會畫在時間軸的對應位置。`highlight: true` 會顯示成黃底反白並使用紅色虛線
- `baseline`：基準線起訖日，用來對比排程延後或提前幾天。`null` 表示沒有基準線
- 時間軸的週／月刻度是**個人檢視偏好**，存在瀏覽器 `localStorage`，不寫進專案檔，所以不會互相干擾

### 舊資料的自動遷移

舊版是「期間」制（任務存第幾期，日期掛在 `periods[]` 上）。開啟舊專案時會自動換算成日期制：

- 原本有填期間日期 → 依那些日期換算，畫面會提示「已換算，請確認後儲存」
- **原本沒填任何期間日期** → 無從得知真實日期，會用「第 1 期從本週一開始、每期兩週」**推算**，並顯示警告要你逐項確認

兩種情況都**只發生在瀏覽器記憶體裡**，按下「儲存到 GitHub」才會寫回檔案。在那之前原始資料不會被動到。

## 功能說明

**時間軸**
- 右上角可切換**週／月**刻度。週刻度上排顯示月份、下排顯示每週起始日；月刻度上排顯示年、下排顯示月份
- 欄寬依實際天數比例計算，所以 2 月和 3 月的寬度不一樣，任務長條的位置精準對應日期
- **今天線**（青色）精準畫在今天的位置，開頁時自動捲到今天
- 專案較長時會自動撐開寬度以保持刻度可讀，用橫向捲動瀏覽

**甘特圖**
- 任務長條的長度等比於實際工期
- 完成度：整個專案、每條軌道、每個任務各自顯示（有細項時依細項完成比例計算）
- 基準線對比：右上角「📏 基準線」切換顯示，延後的任務會標出延後幾天
- 長條太窄放不下標籤時，標籤自動移到長條右側，不會被裁掉一半
- 滑鼠移到長條上會顯示完整資訊（起訖日、工期、負責人、備註、基準線差異）

**編輯**
- 在甘特圖上**直接拖曳長條**移動日期，拖兩端可改工期，**以天為單位**
- 任務用日期選擇器輸入，旁邊即時顯示工期天數
- 階段里程碑可新增／改名／改日期／設定強調／刪除
- 批次調整：可把整條軌道或全部任務一次位移數天或數週，也可選擇讓里程碑一起位移
- 「取消編輯」會完整還原到進入編輯前的狀態；有未儲存變更時關閉分頁會被攔下，並在本機留下草稿，下次開啟可選擇恢復

**從 Excel 匯入**
編輯面板 →「📋 從 Excel 貼上匯入」。在 Excel 選取範圍複製後直接貼上，欄位順序：

| 軌道 | 任務名稱 | 開始日期 | 結束日期 | 狀態 | 負責人 | 備註 |
|---|---|---|---|---|---|---|
| 產品 | 椅腳強度測試 | 2026-09-01 | 2026-09-14 | 進行中 | 王小明 | 含滾輪 |

第一列可以是標題列。日期接受 `2026-09-01` 或 `2026/9/1`；無法確定的寫法（例如 `9/1`、`W38`）會被標為錯誤並略過，不會亂猜年份。軌道不存在時會自動建立，時間軸會自動延伸到涵蓋新任務。貼上後會先顯示預覽與問題清單，確認後才寫入。

**列印 / PDF**
右上角「🖨️ 列印」。已設定 A4 橫向的列印樣式，會隱藏按鈕與編輯面板、強制白底黑字（深色模式也一樣），適合貼進 review 簡報。

## 定時排程提醒（GitHub Actions）

網站上的「近期提醒」只有打開網頁才看得到。`.github/workflows/schedule-reminder.yml` 讓提醒主動送出來：

- 每週一至五台北時間 09:00 執行，也可以到 Actions 頁面手動觸發（可指定「幾天內到期」）
- 掃描所有專案的逾期與近期到期任務（到期日 = 任務的結束日期），結果寫進 Actions 執行摘要
- 並且維護一張帶 `schedule-reminder` 標籤的 GitHub Issue，內容每次更新。**這步用內建的 `GITHUB_TOKEN`，不需要任何額外設定**
- 若想推到 Teams / Slack / Google Chat：到 Settings → Secrets and variables → Actions 新增一個名為 `WEBHOOK_URL` 的 secret，填入該平台的 incoming webhook 網址即可

到期日的算法與網站共用 `utils.js`，不會出現「網站說還有三天、提醒說已逾期」的不一致。

**還沒完成遷移的專案會被跳過**：如果某個專案仍是舊的期間制且沒有填日期，遷移只能「以執行當天往後推算」出日期，每天跑都會得到不同結果。與其發出會漂移的假到期日，腳本會把它列成「請確認日期」而不產生提醒。到網站上開啟該專案、確認換算後的日期並儲存，之後就會正常納入提醒。

**注意**：GitHub 會在 repo 連續 60 天沒有任何活動後自動停用排程 workflow，屆時到 Actions 頁面點一下重新啟用即可。

## 已知限制

- **GitHub API 額度**：沒有設定 token 時，每個 IP 每小時只有 60 次 API 額度。「最後更新者」欄位會用掉一部分，因此結果會在瀏覽器 sessionStorage 快取 5 分鐘。若整間辦公室共用同一個對外 IP 又沒設 token，這個欄位可能偶爾空白（不影響排程本身的顯示與編輯）
- **手機版尚未完整支援**：甘特圖可以橫向滑動，對話框與批次工具在窄畫面已可操作，但編輯面板整體還沒針對手機重新排版
- **軌道顏色的對比度**：`orange`、`slate`、`olive` 三色配白字未達 WCAG AA 標準，深色模式下也未針對軌道色調整
- **專案名稱與軌道仍需改 JSON**：網頁上還不能改專案名稱與說明，也不能新增／刪除／改名／重新排序軌道（匯入時會自動建立新軌道）。里程碑已經可以在網頁上編輯
- **沒有任務依賴關係**：目前任務彼此獨立，某個任務延後不會自動順延下游。要整批調整請用「批次調整」
- **沒有工作日概念**：工期是日曆天，不會跳過週末與假日
