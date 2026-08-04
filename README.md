# GC Gaming Chair Project - 進度追蹤

單頁式專案時間軸追蹤網站，透過 GitHub Pages 發布。

## 本機預覽

因為頁面用 `fetch` 讀取 `data.json`，直接用瀏覽器開 `index.html`（`file://`）會被瀏覽器擋掉，需要用簡單的本機伺服器：

```bash
python -m http.server 8080
```

然後開瀏覽器到 `http://localhost:8080`。

## 更新進度

編輯 `data.json`：

- 新增/修改 `milestones` 陣列裡的項目（`title`、`date`、`status`、`description`）
- `status` 可填 `done`（已完成）、`in-progress`（進行中）、`upcoming`（待辦）

編輯完後 commit + push 到 GitHub，GitHub Pages 會自動重新部署（約 1 分鐘內生效）。

## 發布到 GitHub Pages

1. 在 GitHub 建立一個新的 **public** repository（例如 `gc-gaming-chair-project`）
2. 將這個資料夾 push 上去（見下方指令）
3. 到 repo 的 **Settings → Pages**，Source 選擇 `Deploy from a branch`，Branch 選 `main` / `root`
4. 幾分鐘後即可透過 `https://<你的帳號>.github.io/<repo名稱>/` 存取
