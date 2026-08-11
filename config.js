const REPO_OWNER = "billann98-cell";
const REPO_NAME = "gc-gaming-chair-project";
const BRANCH = "main";
const GH_API = "https://api.github.com";

function getToken() {
  return localStorage.getItem("gh_pat") || "";
}

function setToken(t) {
  if (t) localStorage.setItem("gh_pat", t);
  else localStorage.removeItem("gh_pat");
}

function ensureToken() {
  let t = getToken();
  if (!t) {
    t = window.prompt(
      "需要 GitHub Personal Access Token 才能儲存變更。\n" +
        "請到 github.com → Settings → Developer settings → Fine-grained tokens 建立一個只限本 repo、有 Contents: Read and write 權限的 token，貼在這裡："
    );
    if (t) setToken(t.trim());
  }
  return getToken();
}

function b64EncodeUtf8(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

function b64DecodeUtf8(str) {
  return decodeURIComponent(escape(atob(str)));
}

// 儲存衝突專用錯誤型別，讓 UI 能分辨「別人先改了」與其他失敗
class ConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConflictError";
    this.isConflict = true;
  }
}

// 權限不足專用錯誤型別。403 的意思是「token 本身有效，但不准做這件事」，
// 和 401（token 無效）要分開處理，不然使用者會一直重新產生 token 卻沒解決問題。
class PermissionError extends Error {
  constructor(message) {
    super(message);
    this.name = "PermissionError";
    this.isPermission = true;
  }
}

function ghHeaders(extra) {
  const token = getToken();
  const headers = Object.assign({ Accept: "application/vnd.github+json" }, extra || {});
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

// 從 GitHub API 讀檔，同時取回 sha。
// 這條路徑讀到的一定是 main 上的最新內容，不像 GitHub Pages 的靜態檔會有 CDN 快取延遲。
async function ghGetFile(path) {
  // 用 cache: "no-cache" 而不是在網址後面加時間戳。GitHub API 回應帶有 max-age=60，
  // 若讓瀏覽器快取就可能拿到一分鐘前的舊版本，衝突保護就失效了。
  const res = await fetch(`${GH_API}/repos/${REPO_OWNER}/${REPO_NAME}/contents/${path}?ref=${BRANCH}`, {
    headers: ghHeaders(),
    cache: "no-cache",
  });
  if (res.status === 404) return { json: null, sha: null, missing: true };
  if (!res.ok) throw new Error(`讀取 ${path} 失敗 (${res.status})`);
  const data = await res.json();
  return { json: JSON.parse(b64DecodeUtf8(data.content)), sha: data.sha, missing: false };
}

// 寫檔。sha 必須是「呼叫端載入這份內容時拿到的那個 sha」，
// 這樣 GitHub 才能替我們做樂觀鎖：若期間有人改過，會回 409/422 而不是默默覆蓋。
async function ghPutFile(path, jsonObj, sha, message) {
  const token = ensureToken();
  if (!token) throw new Error("沒有提供 token，取消儲存");

  const body = { message, content: b64EncodeUtf8(JSON.stringify(jsonObj, null, 2)), branch: BRANCH };
  if (sha) body.sha = sha;

  const res = await fetch(`${GH_API}/repos/${REPO_OWNER}/${REPO_NAME}/contents/${path}`, {
    method: "PUT",
    headers: ghHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    if (res.status === 401) {
      setToken("");
      throw new Error("Token 無效或已過期，已清除，請重新輸入");
    }
    if (res.status === 403) {
      throw new PermissionError(
        `Token 有效，但沒有寫入這個 repo 的權限（403）。GitHub 原始訊息：${err.message || "Resource not accessible by personal access token"}`
      );
    }
    if (res.status === 409 || res.status === 422) {
      throw new ConflictError(
        `${path} 已被其他人（或另一個分頁）更新，你的版本是舊的。請重新載入取得最新內容後再改一次。`
      );
    }
    throw new Error(`儲存 ${path} 失敗 (${res.status}) ${err.message || ""}`);
  }
  const out = await res.json();
  return { sha: out.content && out.content.sha, commit: out.commit };
}

// 需要覆蓋既有檔案又「不在意」原本內容時才用（例如把專案加進 index.json 前已先讀過）。
// 一般編輯流程請直接用 ghPutFile 並帶入載入時的 sha。
async function saveJsonFile(path, jsonObj, message) {
  const existing = await ghGetFile(path).catch(() => ({ sha: null }));
  return ghPutFile(path, jsonObj, existing.sha, message);
}

// G2：取得某個檔案最後一次 commit 的作者與時間。公開 repo 不需 token。
//
// 沒有 token 時 GitHub API 每個 IP 每小時只有 60 次額度。首頁每次載入會為每個專案
// 各打一次，整間辦公室共用同一個對外 IP 的話很快就會用完，接著這個欄位就會靜默空白。
// 因此在 sessionStorage 快取幾分鐘，減少重複呼叫；儲存後可用 force 強制重新取得。
const COMMIT_CACHE_MS = 5 * 60 * 1000;

async function ghLatestCommit(path, force) {
  const cacheKey = `gc-commit:${path}`;
  if (!force) {
    try {
      const hit = JSON.parse(sessionStorage.getItem(cacheKey) || "null");
      if (hit && Date.now() - hit.at < COMMIT_CACHE_MS) return hit.value;
    } catch (e) {
      /* 快取壞了就直接打 API */
    }
  }

  const url = `${GH_API}/repos/${REPO_OWNER}/${REPO_NAME}/commits?path=${encodeURIComponent(
    path
  )}&sha=${BRANCH}&per_page=1`;
  const res = await fetch(url, { headers: ghHeaders(), cache: "no-cache" });
  if (!res.ok) return null;
  const list = await res.json();
  if (!Array.isArray(list) || !list.length) return null;
  const c = list[0];
  const value = {
    author: (c.author && c.author.login) || (c.commit.author && c.commit.author.name) || "unknown",
    date: c.commit.author && c.commit.author.date,
    message: c.commit.message,
    url: c.html_url,
  };
  try {
    sessionStorage.setItem(cacheKey, JSON.stringify({ at: Date.now(), value }));
  } catch (e) {
    /* 存不進去不影響功能 */
  }
  return value;
}

/* 診斷 token 到底缺什麼。
   403「Resource not accessible by personal access token」只說「不准」，
   沒說是哪個設定不對，所以這裡分開確認三件事：
   1. token 屬於哪個 GitHub 帳號（很常見的錯是建在另一個帳號上）
   2. token 看不看得到這個 repo
   3. token 有沒有寫入（push）權限 —— 對應 fine-grained 的 Contents: Read and write */
async function ghDiagnoseToken() {
  const token = getToken();
  if (!token) return { ok: false, code: "no-token", message: "還沒設定 token。" };

  let me = null;
  try {
    const res = await fetch(`${GH_API}/user`, { headers: ghHeaders(), cache: "no-cache" });
    if (res.status === 401) {
      return { ok: false, code: "invalid", message: "Token 無效或已過期，請重新產生一個。" };
    }
    if (res.ok) me = await res.json();
  } catch (e) {
    return { ok: false, code: "network", message: `無法連上 GitHub：${e.message}` };
  }

  let repo = null;
  try {
    const res = await fetch(`${GH_API}/repos/${REPO_OWNER}/${REPO_NAME}`, {
      headers: ghHeaders(),
      cache: "no-cache",
    });
    if (res.ok) repo = await res.json();
  } catch (e) {
    /* 下面會依 repo 是否為 null 判斷 */
  }

  const login = me && me.login;
  const canPush = !!(repo && repo.permissions && repo.permissions.push);

  if (!repo) {
    return {
      ok: false,
      code: "no-repo",
      login,
      message: `這個 token 看不到 ${REPO_OWNER}/${REPO_NAME}。請確認 token 的「Repository access」有選到這個 repo。`,
    };
  }

  if (login && login.toLowerCase() !== REPO_OWNER.toLowerCase() && !canPush) {
    return {
      ok: false,
      code: "wrong-account",
      login,
      message: `這個 token 屬於帳號「${login}」，但 repo 的擁有者是「${REPO_OWNER}」，而且該帳號沒有寫入權限。請改用 ${REPO_OWNER} 這個帳號登入 GitHub 後再產生 token。`,
    };
  }

  if (!canPush) {
    return {
      ok: false,
      code: "no-write",
      login,
      message: `Token（帳號 ${login || "未知"}）可以讀取這個 repo，但沒有寫入權限。請把「Permissions → Repository permissions → Contents」改成 Read and write。`,
    };
  }

  return { ok: true, code: "ok", login, message: `Token 正常（帳號 ${login}，具備寫入權限）。` };
}

// 依診斷結果產生「該去改哪裡」的說明（純字串，不碰 DOM）。
// 指引必須對症下藥：token 過期時叫人去改 Contents 權限只會讓人繞遠路。
function ghTokenFixHtml(diag) {
  const settings = `<a href="https://github.com/settings/personal-access-tokens" target="_blank" rel="noopener">Fine-grained tokens 設定頁</a>`;
  const repoName = `<code>${REPO_OWNER}/${REPO_NAME}</code>`;

  if (diag.code === "ok") return `✅ ${diag.message}`;

  const createSteps = `
    <ol>
      <li>到 ${settings} 按 <strong>Generate new token</strong></li>
      <li><strong>Resource owner</strong> 選 <strong>${REPO_OWNER}</strong></li>
      <li><strong>Repository access</strong> → <em>Only select repositories</em> → 加入 ${repoName}</li>
      <li><strong>Permissions → Repository permissions → Contents</strong> → <strong>Read and write</strong></li>
      <li>產生後回到這裡按「🔑 GitHub Token」貼上，系統會自動檢查</li>
    </ol>`;

  const fixSteps = `
    <ol>
      <li>到 ${settings} 點開你正在用的那個 token（<strong>不必重新產生</strong>，改完按 Update 即生效）</li>
      <li><strong>Repository access</strong> → <em>Only select repositories</em> → 確認有 ${repoName}</li>
      <li><strong>Permissions → Repository permissions → Contents</strong> → 改成 <strong>Read and write</strong></li>
      <li>回到這裡按「🔑 GitHub Token」重新貼一次以重新檢查</li>
    </ol>
    <p class="hint">Fine-grained token 預設不含任何權限，Contents 一定要手動設定。</p>`;

  const accountSteps = `
    <ol>
      <li>先用 <strong>${REPO_OWNER}</strong> 這個帳號登入 GitHub（不是目前這個帳號）</li>
      <li>再到 ${settings} 產生 token，Resource owner 選 <strong>${REPO_OWNER}</strong></li>
      <li>Repository access 加入 ${repoName}、Contents 設為 Read and write</li>
    </ol>`;

  const body =
    diag.code === "no-token" || diag.code === "invalid"
      ? createSteps
      : diag.code === "wrong-account"
      ? accountSteps
      : fixSteps;

  return `<strong>${diag.message}</strong>${body}`;
}

function ghFileHistoryUrl(path) {
  return `https://github.com/${REPO_OWNER}/${REPO_NAME}/commits/${BRANCH}/${path}`;
}
