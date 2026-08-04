# 專案排程追蹤（多專案 + 線上編輯）

多專案的甘特圖排程追蹤網站，發布在 GitHub Pages。每個專案是 `projects/` 底下的一個 JSON 檔案，透過瀏覽器直接呼叫 GitHub API 讀寫，不需要後端伺服器。

## 架構

- `index.html` + `dashboard.js`：專案列表首頁，可建立新專案
- `project.html` + `project.js`：單一專案的甘特圖 + 編輯面板
- `config.js`：GitHub repo 設定與 API 呼叫（讀取用 fetch 靜態檔即可，寫入才用 GitHub Contents API）
- `projects/index.json`：所有專案的清單（id/name/description）
- `projects/<id>.json`：每個專案的排程資料

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
2. 建立 token，**Repository access** 只選這個 repo (`gc-gaming-chair-project`)，**Permissions → Contents** 設為 `Read and write`
3. 在網站上點右上角「🔑 GitHub Token」貼上，之後就存在瀏覽器本機（`localStorage`），不會上傳到任何地方
4. 之後點「+ 新增專案」或進入專案點「✏️ 編輯」→「儲存到 GitHub」都會用這個 token 直接對 repo 建立 commit

**注意**：這個 token 等於是你這個 repo 的寫入密碼，請不要分享給別人、不要在公用電腦上貼、也不要貼到其他網站。若懷疑外流，到 GitHub token 設定頁面刪除即可。

## 新增專案裡的任務欄位

每個 task 物件：

```json
{ "title": "任務名稱", "start": 1, "end": 3, "status": "upcoming" }
```

- `start` / `end`：對應 `periods` 的第幾個區間（1 起算）
- `status`：`upcoming`（待辦）/ `in-progress`（進行中）/ `done`（已完成）
