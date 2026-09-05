/* 坚果云书签同步(覆盖式)——运行在扩展内,直接读写授权的坚果云文件夹
 *
 * 模型与独立脚本版一致:
 *   · 坚果云文件夹里只有一个主文件 bookmarks-master.json(带 updated_at/revision)
 *   · 本浏览器书签有变动 → 推送为新主文件(revision+1)
 *   · 主文件比自己新 → 覆盖本浏览器书签(覆盖前自动备份到文件夹里,保留最近 5 份)
 *   · 每个浏览器装本扩展并授权同一文件夹,即互相同步
 */

const Sync = (() => {
  const MASTER_FILE = 'bookmarks-master.json';
  const BACKUP_PREFIX = 'bookmarks-backup-';
  const BACKUP_KEEP = 5;
  const AUTO_THROTTLE_MS = 5 * 60 * 1000;

  const EXT = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id;
  const FSA = typeof window !== 'undefined' && 'showDirectoryPicker' in window;

  /* ---------- IndexedDB:保存文件夹句柄 ---------- */
  function idb() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('bmsync', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  async function kvGet(key) {
    const db = await idb();
    return new Promise((res, rej) => {
      const t = db.transaction('kv').objectStore('kv').get(key);
      t.onsuccess = () => res(t.result);
      t.onerror = () => rej(t.error);
    });
  }
  async function kvSet(key, val) {
    const db = await idb();
    return new Promise((res, rej) => {
      const t = db.transaction('kv', 'readwrite').objectStore('kv').put(val, key);
      t.onsuccess = () => res();
      t.onerror = () => rej(t.error);
    });
  }

  /* ---------- 文件夹句柄与权限 ---------- */
  async function getDir() { return (await kvGet('dir')) || null; }

  async function granted(dir) {
    if (!dir) return false;
    try { return (await dir.queryPermission({ mode: 'readwrite' })) === 'granted'; }
    catch (_) { return false; }
  }

  // 需要用户手势(按钮点击)才能调用;浏览器重启后用这一下恢复授权,不用重新选文件夹
  async function requestGrant(dir) {
    try { return (await dir.requestPermission({ mode: 'readwrite' })) === 'granted'; }
    catch (_) { return false; }
  }

  async function pickFolder() {
    const dir = await window.showDirectoryPicker({ mode: 'readwrite', id: 'nutstore' });
    await kvSet('dir', dir);
    return dir;
  }

  /* ---------- chrome.bookmarks 承诺化 ---------- */
  const bmCall = (fn, ...args) => new Promise((res, rej) =>
    fn(...args, r => chrome.runtime.lastError
      ? rej(new Error(chrome.runtime.lastError.message))
      : res(r)));

  function browserName() {
    const ua = navigator.userAgent;
    if (/Edg\//.test(ua)) return 'Edge';
    if (/Quark/i.test(ua)) return 'Quark';
    return 'Chrome';
  }

  async function localRoots() {
    const [root] = await bmCall(chrome.bookmarks.getTree);
    const kids = root.children || [];
    const bar = kids.find(k => k.folderType === 'bookmarks-bar') || kids[0];
    const other = kids.find(k => k.folderType === 'other') || kids[1] || bar;
    const conv = n => n.url
      ? { type: 'url', name: n.title || '', url: n.url }
      : { type: 'folder', name: n.title || '', children: (n.children || []).map(conv) };
    return { barId: bar.id, otherId: other.id,
             bar: (bar.children || []).map(conv), other: (other.children || []).map(conv) };
  }

  /* ---------- 结构签名(忽略 id/guid/日期) ---------- */
  function normUrl(u) {
    try {
      const p = new URL(u.trim());
      const path = p.pathname !== '/' ? p.pathname.replace(/\/$/, '') : '/';
      return p.origin + path + (p.search || '');
    } catch (_) { return (u || '').trim(); }
  }
  function sigNodes(nodes) {
    return nodes.map(n => n.type === 'url'
      ? { u: normUrl(n.url), n: n.name || '' }
      : { n: n.name || '', c: sigNodes(n.children || []) });
  }
  const signature = (bar, other) => JSON.stringify([sigNodes(bar), sigNodes(other)]);

  /* ---------- 主文件读写 ---------- */
  async function readMaster(dir) {
    try {
      const fh = await dir.getFileHandle(MASTER_FILE, { create: false });
      const txt = await (await fh.getFile()).text();
      return JSON.parse(txt);
    } catch (e) {
      if (e.name === 'NotFoundError' || e.name === 'TypeMismatchError') return null;
      throw e;
    }
  }
  async function writeFile(dir, name, content) {
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(content);
    await w.close();
  }
  const writeMaster = (dir, m) => writeFile(dir, MASTER_FILE, JSON.stringify(m, null, 2));

  async function backup(dir, bar, other) {
    try {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      await writeFile(dir, `${BACKUP_PREFIX}${ts}.json`,
        JSON.stringify({ version: 2, bar, other }, null, 2));
      const names = [];
      for await (const [name] of dir.entries()) {
        if (name.startsWith(BACKUP_PREFIX)) names.push(name);
      }
      names.sort();
      while (names.length > BACKUP_KEEP) await dir.removeEntry(names.shift());
    } catch (e) { console.warn('备份失败(不阻断同步):', e); }
  }

  /* ---------- 覆盖本地书签 ---------- */
  async function clearChildren(id) {
    // 注意:getChildren 返回的节点不填充 children 数组,无法据此区分文件夹;
    // 所以优先 removeTree(递归),失败(说明是普通书签)再退回 remove
    const kids = await bmCall(chrome.bookmarks.getChildren, id);
    for (const k of kids) {
      try {
        await bmCall(chrome.bookmarks.removeTree, k.id);
      } catch (_) {
        await bmCall(chrome.bookmarks.remove, k.id);
      }
    }
  }
  async function createNodes(parentId, nodes) {
    for (const n of nodes) {
      if (n.type === 'url') {
        await bmCall(chrome.bookmarks.create, { parentId, title: n.name || '', url: n.url });
      } else {
        const f = await bmCall(chrome.bookmarks.create, { parentId, title: n.name || '' });
        await createNodes(f.id, n.children || []);
      }
    }
  }

  async function applyMasterToLocal(loc, master, dir) {
    await backup(dir, loc.bar, loc.other);
    await clearChildren(loc.barId);
    await clearChildren(loc.otherId);
    await createNodes(loc.barId, master.roots.bookmark_bar || []);
    await createNodes(loc.otherId, master.roots.other || []);
  }

  /* ---------- 同步主流程 ---------- */
  async function syncNow() {
    if (!EXT) return { ok: false, msg: '预览模式不支持同步' };
    if (!FSA) return { ok: false, msg: '此浏览器不支持文件夹授权' };
    const dir = await getDir();
    if (!dir) return { ok: false, msg: '请先选择坚果云书签文件夹' };
    if (!(await granted(dir))) return { ok: false, msg: '需要重新授权文件夹(点“选择坚果云文件夹”即可)' };

    const loc = await localRoots();
    const ownSig = signature(loc.bar, loc.other);
    const st = await chrome.storage.local.get({ lastRev: 0, lastSig: '', lastSyncAt: '' });
    const master = await readMaster(dir);

    if (!master) {
      const m = { version: 2, updated_at: new Date().toISOString(), revision: 1,
                  source: browserName(), roots: { bookmark_bar: loc.bar, other: loc.other } };
      await writeMaster(dir, m);
      await chrome.storage.local.set({ lastRev: 1, lastSig: ownSig, lastSyncAt: m.updated_at });
      return { ok: true, msg: `已创建初始主文件(${master_count(m)} 条)` };
    }

    const neverSynced = !st.lastSig && !st.lastRev; // 从未同步过:首次接入以主文件为准

    if (neverSynced) {
      // 首次接入:以现有主文件为准覆盖本地,不推送,避免顶掉其他浏览器同步好的内容
      await applyMasterToLocal(loc, master, dir);
      await chrome.storage.local.set({ lastRev: master.revision || 0,
        lastSig: signature(master.roots.bookmark_bar, master.roots.other),
        lastSyncAt: master.updated_at });
      return { ok: true, msg: `首次接入:已按主文件覆盖本地(${master_count(master)} 条)` };
    }

    const localChanged = ownSig !== st.lastSig;
    const masterNewer = (master.revision || 0) !== st.lastRev;

    if (localChanged) {
      const m = { version: 2, updated_at: new Date().toISOString(),
                  revision: (master.revision || 0) + 1, source: browserName(),
                  roots: { bookmark_bar: loc.bar, other: loc.other } };
      await writeMaster(dir, m);
      await chrome.storage.local.set({ lastRev: m.revision, lastSig: ownSig, lastSyncAt: m.updated_at });
      return { ok: true, msg: `已推送本地变动(revision ${m.revision})` };
    }
    if (masterNewer) {
      await applyMasterToLocal(loc, master, dir);
      // 覆盖后本地内容 = 主文件,快照签名必须用主文件的,否则下轮会误判"本地有变动"
      await chrome.storage.local.set({ lastRev: master.revision || 0,
        lastSig: signature(master.roots.bookmark_bar, master.roots.other),
        lastSyncAt: master.updated_at });
      return { ok: true, msg: `已从主文件覆盖本地(revision ${master.revision})` };
    }
    return { ok: true, msg: '书签已一致' };
  }

  function master_count(m) {
    let c = 0;
    (function walk(nodes) { for (const n of nodes) n.type === 'url' ? c++ : walk(n.children || []); })
      ([...(m.roots.bookmark_bar || []), ...(m.roots.other || [])]);
    return c;
  }

  /* ---------- UI ---------- */
  let busy = false;

  async function refreshStatus() {
    const el = document.getElementById('sync-status');
    if (!el) return;
    if (!FSA) { el.textContent = '此浏览器不支持文件夹授权'; return; }
    const dir = await getDir();
    if (!dir) { el.textContent = '状态:未选择文件夹'; return; }
    if (!(await granted(dir))) {
      el.innerHTML = '状态:文件夹已记录,授权已过期 <button id="sync-regrant" class="mini">一键恢复</button>';
      const btn = document.getElementById('sync-regrant');
      if (btn) btn.addEventListener('click', async () => {
        if (await requestGrant(dir)) {
          toast('授权已恢复', true);
          const r = await syncNow();
          if (r) toast(r.msg, r.ok);
        } else toast('未获得授权', false);
        await refreshStatus();
        hideBanner();
      });
      return;
    }
    const st = await chrome.storage.local.get({ lastSyncAt: '' });
    let n = '?';
    try { const m = await readMaster(dir); n = m ? master_count(m) : '无主文件'; } catch (_) {}
    el.textContent = `状态:已连接「${dir.name}」| 主文件 ${n} 条 | 上次同步 ${st.lastSyncAt || '—'}`;
  }

  /* 授权过期时的页面横幅:一键恢复,不用进设置 */
  function showBanner(dir) {
    let banner = document.getElementById('sync-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'sync-banner';
      document.body.appendChild(banner);
    }
    if (banner.querySelector('button')) return;
    banner.innerHTML = '书签同步待恢复授权 <button type="button">一键恢复</button>';
    banner.querySelector('button').addEventListener('click', async () => {
      if (await requestGrant(dir)) {
        hideBanner();
        const r = await syncNow();
        toast(r.msg, r.ok);
      } else {
        toast('未获得授权,可稍后再试', false);
      }
    });
    banner.classList.add('show');
  }
  function hideBanner() {
    const banner = document.getElementById('sync-banner');
    if (banner) banner.remove();
  }

  function toast(msg, ok) {
    let t = document.getElementById('toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'toast';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.className = 'show' + (ok === false ? ' err' : '');
    clearTimeout(t._timer);
    t._timer = setTimeout(() => { t.className = ''; }, 3200);
  }

  function bindUI() {
    const pick = document.getElementById('sync-pick');
    const now = document.getElementById('sync-now');
    const auto = document.getElementById('sync-auto');
    if (!pick) return;

    pick.addEventListener('click', async () => {
      try {
        await pickFolder();
        await refreshStatus();
        const r = await syncNow();
        toast(r.msg, r.ok);
        await refreshStatus();
      } catch (e) {
        if (e.name !== 'AbortError') toast('授权失败:' + e.message, false);
      }
    });

    now.addEventListener('click', async () => {
      if (busy) return;
      busy = true;
      try {
        // 点击本身是用户手势:授权过期时先静默续期,再同步
        const dir = await getDir();
        if (dir && !(await granted(dir))) await requestGrant(dir);
        const r = await syncNow();
        toast(r.msg, r.ok);
        await refreshStatus();
        hideBanner();
      } catch (e) {
        toast('同步失败:' + e.message, false);
      } finally { busy = false; }
    });

    chrome.storage.local.get({ autoSync: true }, ({ autoSync }) => { auto.checked = autoSync; });
    auto.addEventListener('change', () => chrome.storage.local.set({ autoSync: auto.checked }));
  }

  async function autoSync() {
    try {
      const { autoSync: on } = await chrome.storage.local.get({ autoSync: true });
      if (!on) return;
      const dir = await getDir();
      if (!dir) return;
      if (!(await granted(dir))) { showBanner(dir); return; }
      hideBanner();
      const { lastAuto } = await chrome.storage.local.get({ lastAuto: 0 });
      if (Date.now() - lastAuto < AUTO_THROTTLE_MS) return;
      await chrome.storage.local.set({ lastAuto: Date.now() });
      const r = await syncNow();
      if (r.ok && !/已是一致/.test(r.msg)) toast('书签已同步:' + r.msg, true);
    } catch (e) { console.warn('自动同步失败:', e); }
  }

  function init() {
    if (!EXT) return;
    bindUI();
    refreshStatus();
    autoSync();
  }

  return { init, autoSync, syncNow, refreshStatus, pickFolder };
})();

window.Sync = Sync;
