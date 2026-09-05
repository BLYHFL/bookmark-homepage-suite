/* 书签主页 —— 读取收藏夹,渲染成文件夹卡片式新标签页 */

const state = {
  root: null,        // 伪根节点,children = [收藏夹栏, 其他收藏夹, ...]
  bar: null,         // 收藏夹栏
  other: null,       // 其他收藏夹
  currentId: null,   // 当前展示的文件夹 id
  allBookmarks: [],  // 展平的全部书签(用于搜索)
  folderStyle: 'collage', // 文件夹卡片样式:collage | hero | stack | glyph
  EXT: typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id,
};

/* ---------------- 数据 ---------------- */

function loadTree() {
  return new Promise((resolve) => {
    if (state.EXT && chrome.bookmarks) {
      chrome.bookmarks.getTree((tree) => resolve(tree[0]));
    } else if (window.REAL_BOOKMARKS) {
      resolve(window.REAL_BOOKMARKS); // 预览用:注入真实收藏数据
    } else {
      resolve(demoTree()); // 非扩展环境(如直接双击 newtab.html 预览)时使用示例数据
    }
  });
}

function demoTree() {
  const f = (title, children) => ({ id: 'd' + Math.random(), title, children });
  const b = (title, url) => ({ id: 'd' + Math.random(), title, url });
  return {
    id: 'root',
    children: [{
      id: 'bar', title: '收藏夹栏',
      children: [
        f('编程与开发', [
          b('GitHub', 'https://github.com'),
          b('MDN Web Docs', 'https://developer.mozilla.org'),
          b('Stack Overflow', 'https://stackoverflow.com'),
          b('V2EX', 'https://v2ex.com'),
          f('前端', [b('React', 'https://react.dev'), b('Vue', 'https://vuejs.org')]),
        ]),
        f('学术与学习', [
          b('Google Scholar', 'https://scholar.google.com'),
          b('arXiv', 'https://arxiv.org'),
          b('中国知网', 'https://www.cnki.net'),
        ]),
        f('效率工具', [b('Notion', 'https://notion.so'), b('飞书', 'https://feishu.cn')]),
        f('工作', [b('企业微信', 'https://work.weixin.qq.com')]),
        f('AI 与开发', [b('ChatGPT', 'https://chatgpt.com'), b('Hugging Face', 'https://huggingface.co')]),
        f('影视娱乐', [
          b('哔哩哔哩', 'https://bilibili.com'),
          b('豆瓣', 'https://douban.com'),
          b('YouTube', 'https://youtube.com'),
          b('抖音', 'https://douyin.com'),
          b('爱奇艺', 'https://iqiyi.com'),
        ]),
        f('资源与导航', [b(' Bing', 'https://bing.com')]),
        b('深澜软件', 'https://example.com'),
      ],
    }, {
      id: 'other', title: '其他收藏夹',
      children: [b('示例书签', 'https://example.org')],
    }],
  };
}

function flatten(node, list) {
  if (!node.children) return;
  for (const c of node.children) {
    if (c.url) list.push(c);
    else flatten(c, list);
  }
}

function findNode(node, id) {
  if (node.id === id) return node;
  for (const c of node.children || []) {
    const hit = findNode(c, id);
    if (hit) return hit;
  }
  return null;
}

function folderIcons(node) {
  // 取文件夹内前 4 个书签的 url,供 2×2 拼贴
  const out = [];
  (function walk(n) {
    if (out.length >= 4) return;
    for (const c of n.children || []) {
      if (out.length >= 4) return;
      if (c.url) out.push(c.url);
      else walk(c);
    }
  })(node);
  return out;
}

/* ---------------- 渲染 ---------------- */

/* 统一图标容器:白色圆角底座 + favicon/字母 */
function iconChip(url, size) {
  const chip = document.createElement('div');
  chip.className = 'chip chip-' + size; // 'lg' 单书签 | 'sm' 文件夹拼贴
  if (state.EXT) {
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.alt = '';
    img.src = `chrome-extension://${chrome.runtime.id}/_favicon/?pageUrl=${encodeURIComponent(url)}&size=${size === 'lg' ? 64 : 32}`;
    img.onerror = () => img.replaceWith(letterEl(url));
    chip.appendChild(img);
  } else {
    chip.appendChild(letterEl(url)); // 预览环境没有 _favicon 服务,直接用字母图标
  }
  return chip;
}

function letterEl(url) {
  let host = url;
  try { host = new URL(url).hostname.replace(/^www\./, ''); } catch (_) {}
  const el = document.createElement('div');
  el.className = 'letter';
  const hue = [...host].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 360, 7);
  el.style.background = `linear-gradient(135deg, hsl(${hue} 70% 62%), hsl(${(hue + 40) % 360} 70% 46%))`;
  el.style.color = '#fff';
  el.textContent = (host[0] || '?').toUpperCase();
  return el;
}

function countUrls(node) {
  let n = 0;
  for (const c of node.children || []) {
    if (c.url) n++;
    else n += countUrls(c);
  }
  return n;
}

function badgeEl(n) {
  const b = document.createElement('span');
  b.className = 'count-badge';
  b.textContent = n > 99 ? '99+' : String(n);
  return b;
}

/* 层叠样式专用:不带白色底座,直接显示 favicon;加载失败退化为彩色字母块 */
function rawFavicon(url) {
  if (!state.EXT) return stackLetter(url);
  const img = document.createElement('img');
  img.src = `chrome-extension://${chrome.runtime.id}/_favicon/?pageUrl=${encodeURIComponent(url)}&size=32`;
  img.onerror = () => img.replaceWith(stackLetter(url));
  return img;
}

function stackLetter(url) {
  return letterEl(url);
}

function folderGlyph() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '42');
  svg.setAttribute('height', '42');
  svg.setAttribute('viewBox', '0 0 24 24');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('fill', 'currentColor');
  p.setAttribute('d', 'M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z');
  svg.appendChild(p);
  return svg;
}

/* 文件夹卡片的四种呈现方式 */
function folderFaceContent(face, node) {
  const urls = folderIcons(node);
  const style = state.folderStyle;

  if (style === 'hero') {
    face.classList.add('hero');
    if (urls[0]) face.appendChild(iconChip(urls[0], 'lg'));
    else face.appendChild(folderGlyph());
    face.appendChild(badgeEl(countUrls(node)));
    return;
  }
  if (style === 'stack') {
    const stack = document.createElement('div');
    stack.className = 'stack';
    for (const u of urls.slice(0, 3)) stack.appendChild(rawFavicon(u));
    if (!urls.length) face.appendChild(folderGlyph());
    else face.appendChild(stack);
    return;
  }
  if (style === 'glyph') {
    face.classList.add('glyph');
    face.appendChild(folderGlyph());
    face.appendChild(badgeEl(countUrls(node)));
    return;
  }
  // 默认 collage:2×2 图标组
  face.classList.add('folder');
  for (let i = 0; i < 4; i++) {
    if (urls[i]) face.appendChild(iconChip(urls[i], 'sm'));
    else {
      const p = document.createElement('div');
      p.className = 'placeholder';
      face.appendChild(p);
    }
  }
}

function tile(node) {
  const tileEl = document.createElement('div');
  tileEl.className = 'tile';
  tileEl.setAttribute('role', 'listitem');
  const face = document.createElement('div');
  const label = document.createElement('div');
  label.className = 'tile-label';
  label.textContent = node.title || '(无标题)';

  if (node.children) {
    face.className = 'tile-face';
    folderFaceContent(face, node);
    tileEl.addEventListener('click', () => enterFolder(node.id));
  } else {
    face.className = 'tile-face single';
    face.appendChild(iconChip(node.url, 'lg'));
    tileEl.title = node.url;
    tileEl.addEventListener('click', () => { window.location.href = node.url; });
  }

  tileEl.appendChild(face);
  tileEl.appendChild(label);
  return tileEl;
}

function enterFolder(id) {
  state.currentId = id;
  render();
}

function renderBreadcrumb(chain) {
  const nav = document.getElementById('breadcrumb');
  nav.innerHTML = '';
  const sep = () => { const s = document.createElement('span'); s.className = 'sep'; s.textContent = '›'; return s; };
  chain.forEach((node, i) => {
    if (i > 0) nav.appendChild(sep());
    const c = document.createElement('span');
    c.className = 'crumb';
    c.textContent = node.title || '收藏夹';
    if (i < chain.length - 1) c.addEventListener('click', () => enterFolder(node.id));
    nav.appendChild(c);
  });
}

function chainTo(id) {
  const chain = [];
  (function walk(node, path) {
    const next = node === state.root ? path : path.concat(node);
    if (node.id === id) { chain.push(...next); return true; }
    for (const c of node.children || []) {
      if (walk(c, next)) return true;
    }
    return false;
  })(state.root, []);
  return chain;
}

function renderGrid(children) {
  const grid = document.getElementById('grid');
  const empty = document.getElementById('empty');
  grid.innerHTML = '';
  const folders = children.filter((c) => c.children);
  const urls = children.filter((c) => c.url);
  const nodes = [...folders, ...urls];
  empty.classList.toggle('hidden', nodes.length > 0);
  for (const n of nodes) grid.appendChild(tile(n));
}

function render() {
  const node = findNode(state.root, state.currentId) || state.bar;
  state.currentId = node.id;
  renderBreadcrumb(chainTo(node.id));
  renderGrid(node.children || []);
}

/* ---------------- 搜索框:书签下拉建议 ---------------- */

const searchInput = document.getElementById('search');
const suggestEl = document.getElementById('suggest');
let sgItems = [];   // [{ url | bingTag, el }]
let sgActive = -1;

function hideSuggest() {
  suggestEl.classList.add('hidden');
  suggestEl.innerHTML = '';
  sgItems = [];
  sgActive = -1;
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch (_) { return ''; }
}

function renderSuggest(query) {
  const q = query.trim().toLowerCase();
  if (!q) { hideSuggest(); return; }
  const hits = state.allBookmarks.filter(
    (b) => (b.title || '').toLowerCase().includes(q) || (b.url || '').toLowerCase().includes(q)
  ).slice(0, 8);

  suggestEl.innerHTML = '';
  sgItems = [];
  sgActive = -1;

  if (hits.length) {
    const list = document.createElement('div');
    list.className = 'sg-list';
    for (const b of hits) {
      const it = document.createElement('div');
      it.className = 'sg-item';
      it.appendChild(iconChip(b.url, 'sm'));
      const t = document.createElement('span');
      t.className = 't';
      t.textContent = b.title || b.url;
      it.appendChild(t);
      const h = document.createElement('span');
      h.className = 'h';
      h.textContent = hostOf(b.url);
      it.appendChild(h);
      // mousedown 在 blur 之前触发,避免下拉先被关闭
      it.addEventListener('mousedown', (e) => { e.preventDefault(); hideSuggest(); window.location.href = b.url; });
      list.appendChild(it);
      sgItems.push({ target: b.url, el: it });
    }
    suggestEl.appendChild(list);
  }

  const foot = document.createElement('div');
  foot.className = 'sg-item sg-footer';
  foot.textContent = `必应搜索“${query.trim()}”`;
  foot.addEventListener('mousedown', (e) => {
    e.preventDefault();
    window.location.href = 'https://www.bing.com/search?q=' + encodeURIComponent(query.trim());
  });
  suggestEl.appendChild(foot);
  sgItems.push({ target: '__bing__', el: foot });

  suggestEl.classList.remove('hidden');
}

function openActive() {
  if (sgActive < 0 || !sgItems[sgActive]) return false;
  const target = sgItems[sgActive].target;
  hideSuggest();
  window.location.href = target === '__bing__'
    ? 'https://www.bing.com/search?q=' + encodeURIComponent(searchInput.value.trim())
    : target;
  return true;
}

searchInput.addEventListener('input', () => renderSuggest(searchInput.value));

searchInput.addEventListener('blur', () => setTimeout(hideSuggest, 120));

searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { hideSuggest(); searchInput.blur(); return; }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!sgItems.length) return;
    e.preventDefault();
    const n = sgItems.length;
    sgActive = e.key === 'ArrowDown' ? (sgActive + 1) % n : (sgActive - 1 + n) % n;
    sgItems.forEach((it, i) => it.el.classList.toggle('active', i === sgActive));
    return;
  }
  if (e.key !== 'Enter') return;
  const v = searchInput.value.trim();
  if (!v) return;
  if (openActive()) return;
  // 看起来像网址就直接打开,否则用必应搜索
  if (/^https?:\/\//i.test(v) || (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(v) && !v.includes(' '))) {
    window.location.href = /^https?:\/\//i.test(v) ? v : 'https://' + v;
  } else {
    window.location.href = 'https://www.bing.com/search?q=' + encodeURIComponent(v);
  }
});

const settingsDialog = document.getElementById('settings');
const wallpaperInput = document.getElementById('wallpaper-url');

function store() { return state.EXT && chrome.storage ? chrome.storage.local : null; }

function applyWallpaper(url) {
  const photo = document.getElementById('bg-photo');
  if (url) {
    photo.src = url;
    photo.classList.remove('hidden');
    requestAnimationFrame(() => photo.classList.add('show'));
    adaptTextTheme(url);
  } else {
    photo.classList.remove('show');
    photo.classList.add('hidden');
    photo.src = ''; // 露出下层默认渐变
    document.body.classList.remove('light-bg');
  }
}

/* 采样壁纸平均亮度:亮壁纸翻转为深色文字 */
function adaptTextTheme(url) {
  const img = new Image();
  img.onload = () => {
    try {
      const s = 48;
      const c = document.createElement('canvas');
      c.width = s; c.height = s;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, s, s);
      const d = ctx.getImageData(0, 0, s, s).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      const luminance = sum / (d.length / 4) / 255;
      document.body.classList.toggle('light-bg', luminance > 0.62);
    } catch (_) {
      // 远程图片会导致画布被污染,读不出像素:保持白字
      document.body.classList.remove('light-bg');
    }
  };
  img.onerror = () => document.body.classList.remove('light-bg');
  img.src = url;
}

// 壁纸加载失败时回退到渐变,不白屏
document.getElementById('bg-photo').addEventListener('error', function () {
  this.classList.remove('show');
});

// 本地图片上传:压缩成 dataURL 存储,不依赖外链
function downscaleToFit(dataUrl, maxW, cb) {
  const img = new Image();
  img.onload = () => {
    try {
      const scale = Math.min(1, maxW / img.width);
      if (scale === 1 && dataUrl.length < 2_000_000) return cb(dataUrl);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      cb(canvas.toDataURL('image/jpeg', 0.85));
    } catch (e) {
      alert('图片处理失败:' + e.message);
    }
  };
  img.onerror = () => alert('这张图片无法解码,请换一张(JPG/PNG/WebP 都可以)');
  img.src = dataUrl;
}

const wpFile = document.getElementById('wp-file');

/* 文件夹卡片样式切换 */
const STYLE_NAMES = { collage: '图标组', hero: '单图标', stack: '层叠', glyph: '文件夹' };
const styleRow = document.getElementById('style-row');

function renderStyleRow() {
  styleRow.innerHTML = '';
  for (const [key, name] of Object.entries(STYLE_NAMES)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = name;
    b.className = state.folderStyle === key ? 'active' : '';
    b.addEventListener('click', () => {
      state.folderStyle = key;
      const s = store();
      if (s) s.set({ folderStyle: key });
      else localStorage.setItem('folderStyle', key);
      renderStyleRow();
      render();
    });
    styleRow.appendChild(b);
  }
}

document.getElementById('settings-btn').addEventListener('click', async () => {
  const s = store();
  const cur = s ? (await s.get('wallpaper')).wallpaper || '' : localStorage.getItem('wallpaper') || '';
  wallpaperInput.value = cur.startsWith('data:') ? '' : cur;
  wallpaperInput.placeholder = cur.startsWith('data:') ? '(当前使用本地图片,填入新地址可覆盖)' : 'https://...';
  renderStyleRow();
  settingsDialog.showModal();
});
document.getElementById('wp-upload').addEventListener('click', () => wpFile.click());
wpFile.addEventListener('change', () => {
  const file = wpFile.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => downscaleToFit(reader.result, 1920, (dataUrl) => {
    const s = store();
    const save = s ? s.set({ wallpaper: dataUrl }) : Promise.resolve(localStorage.setItem('wallpaper', dataUrl));
    save.catch(() => alert('保存失败:图片过大,请换一张小一点的'));
    save.then(() => {
      wallpaperInput.value = '';
      applyWallpaper(dataUrl);
      settingsDialog.close();
    });
  });
  reader.onerror = () => alert('读取文件失败,请重试');
  reader.readAsDataURL(file);
});

document.getElementById('wp-save').addEventListener('click', () => {
  const url = wallpaperInput.value.trim();
  const s = store();
  if (s) s.set({ wallpaper: url });
  else localStorage.setItem('wallpaper', url);
  applyWallpaper(url);
  settingsDialog.close();
});
document.getElementById('wp-reset').addEventListener('click', () => {
  const s = store();
  if (s) s.set({ wallpaper: '' });
  else localStorage.setItem('wallpaper', '');
  wallpaperInput.value = '';
  applyWallpaper('');
});

/* ---------------- 启动 ---------------- */

(async function init() {
  // 预览调试支持:?folderStyle=hero 等强制指定样式
  const urlStyle = new URLSearchParams(location.search).get('folderStyle');
  if (urlStyle && STYLE_NAMES[urlStyle]) state.folderStyle = urlStyle;
  else {
    const s = store();
    const saved = s ? (await s.get('folderStyle')).folderStyle : localStorage.getItem('folderStyle');
    if (saved && STYLE_NAMES[saved]) state.folderStyle = saved;
  }

  if (window.Sync) Sync.init();  // 坚果云同步(自动 + 状态)

  state.root = await loadTree();
  state.bar = state.root.children.find((c) => c.title.includes('收藏夹栏') || c.title.includes('Bookmarks bar')) || state.root.children[0];
  state.other = state.root.children.find((c) => c.id === 'other' || c.title.includes('其他')) || state.root.children[1];
  flatten(state.root, state.allBookmarks);
  state.currentId = state.bar.id;

  const s = store();
  if (s) {
    const { wallpaper } = await s.get('wallpaper');
    if (wallpaper) applyWallpaper(wallpaper);
  } else {
    applyWallpaper(localStorage.getItem('wallpaper') || '');
  }

  render();
  searchInput.focus();
})();
