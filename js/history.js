// Scan history kept as a JSON file in the app's GitHub repo, read and written through
// GitHub's contents API. Writing needs a token, which the owner pastes into Settings;
// it's kept only in that browser's storage, never in the repo.

export const HISTORY_FILE = { owner: 'raman365', repo: 'tapeline', path: 'data/history.json', branch: 'main' };
const TOKEN_KEY = 'tapeline:githubToken';

export const fileUrl = () => {
  const f = HISTORY_FILE;
  return `https://github.com/${f.owner}/${f.repo}/blob/${f.branch}/${f.path}`;
};

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || '';
  } catch {
    return '';
  }
}

export function setToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Storage blocked; the token just won't be remembered.
  }
}

// UTF-8 safe base64, as the contents API expects.
function encode(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
const decode = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, '')), (c) => c.charCodeAt(0)));

async function github(url, { method = 'GET', body, token = getToken() } = {}) {
  return fetch(url, {
    method,
    cache: 'no-store',
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(token && { Authorization: `Bearer ${token}` }),
      ...(body && { 'Content-Type': 'application/json' }),
    },
    body: body && JSON.stringify(body),
  });
}

const contentsUrl = () => {
  const f = HISTORY_FILE;
  return `https://api.github.com/repos/${f.owner}/${f.repo}/contents/${f.path}`;
};

function problem(res, writing) {
  const f = HISTORY_FILE;
  if (res.status === 401) return 'GitHub rejected the token. It may have expired or been revoked. Paste a new one in Settings.';
  if (writing && (res.status === 403 || res.status === 404)) {
    return `The token can't write to ${f.owner}/${f.repo}. Give it access to that repository with Contents set to "Read and write".`;
  }
  if (res.status === 403) return 'GitHub is limiting requests right now. Try again in a few minutes.';
  return `GitHub returned an error (${res.status}).`;
}

// Checks a token and returns the GitHub username it belongs to.
export async function verifyToken(token) {
  const res = await github('https://api.github.com/user', { token });
  if (!res.ok) throw new Error(problem(res, false));
  return (await res.json()).login;
}

// The saved scans, newest first, plus the file's current version (sha) for writing.
export async function readHistory() {
  const res = await github(`${contentsUrl()}?ref=${encodeURIComponent(HISTORY_FILE.branch)}`);
  if (res.status === 404) return { scans: [], sha: null }; // no scans saved yet
  if (!res.ok) throw new Error(problem(res, false));
  const file = await res.json();
  // Files over 1 MB come back without content; fetch those raw.
  const text = file.encoding === 'base64' ? decode(file.content) : await (await fetch(file.download_url, { cache: 'no-store' })).text();
  const scans = JSON.parse(text || '[]');
  return { scans: Array.isArray(scans) ? scans : [], sha: file.sha };
}

// Adds scans (replacing any with the same time) and commits the file. If the file
// changed on GitHub in between, reads it again and retries.
export async function saveScans(entries, message) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { scans, sha } = await readHistory();
    const times = new Set(entries.map((e) => e.at));
    const next = [...entries, ...scans.filter((s) => !times.has(s.at))].sort((a, b) => b.at - a.at);
    const res = await github(contentsUrl(), {
      method: 'PUT',
      body: {
        message,
        content: encode(`${JSON.stringify(next, null, 2)}\n`),
        branch: HISTORY_FILE.branch,
        ...(sha && { sha }),
      },
    });
    if (res.ok) return next;
    // 409: someone saved in between. 422 without a sha: the file was just created.
    if (res.status !== 409 && !(res.status === 422 && !sha)) throw new Error(problem(res, true));
  }
  throw new Error('The history file kept changing while saving. Try again.');
}
