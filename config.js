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

function ghFileHistoryUrl(path) {
  return `https://github.com/${REPO_OWNER}/${REPO_NAME}/commits/${BRANCH}/${path}`;
}
