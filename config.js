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

async function ghGetFile(path) {
  const token = getToken();
  const headers = { Accept: "application/vnd.github+json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(
    `${GH_API}/repos/${REPO_OWNER}/${REPO_NAME}/contents/${path}?ref=${BRANCH}&_=${Date.now()}`,
    { headers }
  );
  if (!res.ok) throw new Error(`讀取 ${path} 失敗 (${res.status})`);
  const data = await res.json();
  return { json: JSON.parse(b64DecodeUtf8(data.content)), sha: data.sha };
}

async function ghPutFile(path, jsonObj, sha, message) {
  const token = ensureToken();
  if (!token) throw new Error("沒有提供 token，取消儲存");
  const body = {
    message,
    content: b64EncodeUtf8(JSON.stringify(jsonObj, null, 2)),
    branch: BRANCH,
  };
  if (sha) body.sha = sha;
  const res = await fetch(`${GH_API}/repos/${REPO_OWNER}/${REPO_NAME}/contents/${path}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    if (res.status === 401) setToken("");
    throw new Error(`儲存 ${path} 失敗 (${res.status}) ${err.message || ""}`);
  }
  return res.json();
}

async function saveJsonFile(path, jsonObj, message) {
  let sha;
  try {
    const existing = await ghGetFile(path);
    sha = existing.sha;
  } catch (e) {
    sha = undefined;
  }
  return ghPutFile(path, jsonObj, sha, message);
}
