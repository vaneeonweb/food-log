// drive.js — Google Drive auto-sync (offline-first).
//
// Writes each day's CONFIRMED captures to Drive as RAW records (food key/text +
// portion + timestamp — NOT macros; the Mac derives macros so history can be
// re-enriched later, PLAN.md §3.4/§5). Layout:
//     food_log/<YYYY>/<MM>/W<n>/<YYYY-MM-DD>.jsonl   (week = month-relative W1–W5)
//
// Auth is Google Identity Services (short-lived access token, public client id,
// drive.file scope). Capture NEVER depends on this: entries live in IndexedDB the
// moment they are confirmed, each affected day is marked dirty, and the queue is
// flushed to Drive whenever we are online and connected. A full day-file is
// rewritten on each push, so syncing is idempotent and reflects edits/deletes.
window.Drive = (() => {
  let tokenClient = null;
  let accessToken = null;
  let tokenExpiry = 0;
  const folderCache = {}; // "parentId/name" -> folderId

  const ready = () =>
    typeof google !== "undefined" && google.accounts && google.accounts.oauth2;

  function init() {
    if (tokenClient || !ready()) return;
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: window.CONFIG.CLIENT_ID,
      scope: window.CONFIG.SCOPE,
      callback: () => {},
    });
  }

  // Resolve a valid access token. interactive=true is required for the first
  // consent (must be triggered by a user click); after that, silent works while
  // the Google session is alive.
  function getToken(interactive) {
    return new Promise((resolve, reject) => {
      if (accessToken && Date.now() < tokenExpiry - 60000) return resolve(accessToken);
      if (!ready()) return reject(new Error("Google sign-in unavailable (offline?)"));
      init();
      tokenClient.callback = (resp) => {
        if (resp.error) return reject(new Error(resp.error));
        accessToken = resp.access_token;
        tokenExpiry = Date.now() + (resp.expires_in || 3600) * 1000;
        localStorage.setItem("driveConnected", "1");
        resolve(accessToken);
      };
      tokenClient.requestAccessToken({ prompt: interactive ? "consent" : "" });
    });
  }

  async function api(url, opts = {}) {
    const token = await getToken(false);
    const resp = await fetch(url, {
      ...opts,
      headers: { Authorization: `Bearer ${token}`, ...(opts.headers || {}) },
    });
    if (!resp.ok) throw new Error(`Drive ${resp.status}: ${await resp.text()}`);
    return resp.json();
  }

  async function findChild(name, parentId) {
    const q = `name='${name.replace(/'/g, "\\'")}' and '${parentId}' in parents and trashed=false`;
    const data = await api(
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)&spaces=drive`
    );
    return data.files && data.files[0] ? data.files[0].id : null;
  }

  async function ensureFolder(name, parentId) {
    const key = `${parentId}/${name}`;
    if (folderCache[key]) return folderCache[key];
    let id = await findChild(name, parentId);
    if (!id) {
      const data = await api("https://www.googleapis.com/drive/v3/files", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          mimeType: "application/vnd.google-apps.folder",
          parents: [parentId],
        }),
      });
      id = data.id;
    }
    folderCache[key] = id;
    return id;
  }

  async function ensureDayFolder(date) {
    const [y, m, d] = date.split("-");
    const week = "W" + Math.ceil(parseInt(d, 10) / 7); // month-relative W1–W5
    const root = await ensureFolder(window.CONFIG.ROOT_FOLDER, "root");
    const yy = await ensureFolder(y, root);
    const mm = await ensureFolder(m, yy);
    return ensureFolder(week, mm);
  }

  async function upsertDayFile(date, jsonl) {
    const folderId = await ensureDayFolder(date);
    const filename = `${date}.jsonl`;
    const existingId = await findChild(filename, folderId);
    const token = await getToken(false);

    if (existingId) {
      const resp = await fetch(
        `https://www.googleapis.com/upload/drive/v3/files/${existingId}?uploadType=media`,
        { method: "PATCH", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-ndjson" }, body: jsonl }
      );
      if (!resp.ok) throw new Error(`Drive update ${resp.status}`);
    } else {
      const boundary = "foodlog" + Date.now();
      const metadata = { name: filename, parents: [folderId] };
      const body =
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
        `--${boundary}\r\nContent-Type: application/x-ndjson\r\n\r\n${jsonl}\r\n--${boundary}--`;
      const resp = await fetch(
        "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart",
        { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/related; boundary=${boundary}` }, body }
      );
      if (!resp.ok) throw new Error(`Drive create ${resp.status}`);
    }
  }

  // The raw record that lands in Drive — deliberately WITHOUT macros.
  function toRawRecord(e) {
    return {
      id: e.id, logged_at: e.logged_at, date: e.date, time: e.time, meal: e.meal,
      food: e.food, raw_text: e.raw_text, amount: e.amount, unit: e.unit,
      state: e.state, resolved: e.resolved, confidence: e.confidence, source: e.source,
    };
  }

  async function sync() {
    if (!navigator.onLine) return { ok: false, reason: "offline" };
    if (!localStorage.getItem("driveConnected")) return { ok: false, reason: "not connected" };
    const dates = window.Store.getDirtyDates();
    for (const date of dates) {
      const entries = await window.Store.getEntriesByDate(date);
      const jsonl = entries.map((e) => JSON.stringify(toRawRecord(e))).join("\n");
      await upsertDayFile(date, entries.length ? jsonl + "\n" : "");
      window.Store.clearDirty(date);
    }
    return { ok: true, synced: dates.length };
  }

  async function connect() {
    await getToken(true); // interactive consent — must be user-initiated
    return sync();
  }

  const isConnected = () => !!localStorage.getItem("driveConnected");

  return { sync, connect, isConnected, ready, _ensureDayFolder: ensureDayFolder, _toRawRecord: toRawRecord };
})();
