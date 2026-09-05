# AGENTS.md —— 给 AI 编码代理的项目指南

本项目(`bookmark-homepage-suite/`)包含一个 Edge/Chrome 新标签页扩展(含坚果云书签同步)和一个可选的独立 Python 同步脚本。改代码前先读完本文件,可以避开这里记录过的所有坑。

> 工作区说明:上级目录 `临时项目/` 是多项目工作区,每个一级子文件夹是一个独立项目,各带自己的 README.md 与 AGENTS.md。新建项目请照此办理,不要把文件散在工作区根目录。

## 项目布局

```
bookmark-homepage/    # 浏览器扩展(MV3)。用户已在 edge://extensions 以"加载解压缩"方式
                      # 引用本文件夹(完整路径:临时项目/bookmark-homepage-suite/bookmark-homepage)
                      # ——【禁止移动/重命名此目录】;若必须移动,要提醒用户去扩展页重新加载
  manifest.json       # MV3;permissions: bookmarks, favicon, storage;接管新标签页
  newtab.html/css/js  # 新标签页 UI(原生 JS,无构建、无依赖)
  sync.js             # 坚果云同步模块(暴露 window.Sync,自注册 UI,init() 由 newtab.js 调)
  icons/gen_icons.py  # 生成 PNG 图标的纯 Python 脚本(改图标后重跑)
bookmark-sync/        # 独立同步脚本(可选,与扩展同步二选一运行)
  bookmark-sync.py    # 同步引擎;install.sh 装 launchd 常驻(当前已暂停)
dist/                 # crx/pem/zip 打包产物;pem 是扩展私钥,丢了扩展 ID 就变了
```

## 硬性约定

- **UI 文案一律中文**;代码注释也用中文
- 扩展是**原生 JavaScript**(ES2020+,Chromium 150+),禁止引入构建工具/框架/npm
- `bookmark-sync.py` **只用 Python 标准库**(json/os/plistlib/shutil/subprocess/uuid 等)
- 主文件格式变更必须 `version` 字段 +1,并兼容读取旧格式

## 领域知识(踩过的坑,勿再踩)

### 浏览器书签文件
- Edge/夸克等 Chromium 系书签是 JSON,路径 `~/Library/Application Support/<浏览器名>/<Profile>/Bookmarks`;**Chrome 特例:是 `Google/Chrome` 两级目录,不是 `Google Chrome`**(踩过)
- Safari 是 plist(`~/Library/Safari/Bookmarks.plist`),读取需要"完全磁盘访问权限";节点字段是 `WebBookmarkType/URIDictionary/URLString/Children`
- **正在运行的浏览器会在退出时用自己的内存数据覆盖书签文件**——任何直接写书签文件的行为必须先 `pgrep -x <进程名>` 确认浏览器未运行,且写入前备份
- 书签 JSON 里的 `checksum` 字段不用管:内容改动后校验和不匹配,Chromium 会自己重算重写,不会丢弃内容
- `~/Library/Application Support/Session Storage`、`Sessions/` 与书签无关(前者是网站 sessionStorage,后者是打开的标签页)

### 扩展沙箱(MV3)
- 扩展**不能读磁盘文件**(所以才有 File System Access API 授权文件夹方案);也不能读 `Bookmarks` 文件,读写自己浏览器的书签一律走 `chrome.bookmarks`
- `_favicon/` 端点(需 manifest 声明 `"favicon"` 权限)只在扩展环境可用;file:// 预览时 `state.EXT` 为 false,走字母/渐变兜底
- MV3 默认 CSP 禁止远程脚本;`chrome.bookmarks` 回调式 API 用 `bmCall` 包装成 Promise,记得判 `chrome.runtime.lastError`

### 跨平台(bookmark-sync.py)
- `sys.platform` 分支:darwin / win32 / linux;浏览器清单在 `_chromium_browsers()`(数据目录三套)、进程检测 `process_running()`(Windows 用 `tasklist /FI IMAGENAME`,其余 `pgrep -x`)
- 坚果云目录按候选列表探测(Windows `~/我的坚果云`、mac `~/Nutstore Files/我的坚果云`、Linux 两种),探测不到回退第一个候选;快照/日志目录也按平台区分
- Safari 条目仅 darwin 注入;install.sh 只管 macOS(launchd),Windows/Linux 常驻命令写在 README
- 测平台相关改动时,一律用 `BMSYNC_*` 环境变量隔离测试,不要动真实书签

### 覆盖式同步的核心语义
- 主文件 `bookmarks-master.json`:节点只有 `{type:url,name,url}` 与 `{type:folder,name,children}` 两种,**不含 id/guid/日期**(id 是各浏览器本地的,写入时重新编号)
- `revision` 单调递增,是同步方向的唯一判据;**生成新主文件时必须继承旧 revision 再 +1**(踩过:重置为 1 导致同步方向判断失灵)
- 判断"浏览器是否需要覆盖"的结构签名只含 类型/名称/URL/层级,**必须忽略 id/guid/date**(踩过:覆盖写入会重编 id,把签名算进去会导致内容相同却反复触发同步)
- 时间戳要**微秒精度**且仅作展示(踩过:秒级精度下同秒操作判断失灵)
- 首次接入(本地无 lastSig/lastRev)以现有主文件为准覆盖本地,**不推送**——防止刚装的浏览器把自己空书签推成主文件
- 冲突规则:多个浏览器同时变动,文件 mtime 新的胜出,另一方独有改动被覆盖(用户知情并接受;备份可救回)

## 测试方法(无自动化框架,按此手动验证)

### 扩展
```bash
node --check newtab.js && node --check sync.js     # 语法
# 无头截图验证 UI(直接开 newtab.html 会走内置示例数据,字母占位图标是正常的):
"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" --headless --disable-gpu \
  --hide-scrollbars --window-size=1600,900 --virtual-time-budget=4000 \
  --screenshot=/tmp/preview.png "file:///…/bookmark-homepage/newtab.html"
```
- URL 参数 `?folderStyle=collage|hero|stack|glyph` 可强制指定文件夹卡片样式
- 把真实书签 JSON 塞进 `window.REAL_BOOKMARKS`(`sync.js` 之前加载)可用真实数据预览
- File System Access API 授权流程无法无头测试,改动 sync.js 后需要真人在浏览器里点一遍

### 独立脚本
用环境变量做完全隔离的端到端测试(不动真实书签):
```bash
BMSYNC_CONFIG=/tmp/t/config.json     # 指定浏览器清单 JSON(指向伪造书签文件、伪造进程名)
BMSYNC_STORE_DIR=/tmp/t/store        # 主文件目录(代替坚果云文件夹)
BMSYNC_STATE_DIR=/tmp/t/state        # 快照目录
python3 bookmark-sync.py
```
伪造进程名(如 FakeChrome)保证 pgrep 找不到进程 → 走完整写入路径。标准断言:主文件与两浏览器 `bookmark_bar.children` 去掉 id/guid/date 后深度相等;变动浏览器的 `source` 正确;无变化轮零写入。

### 部署位置(改完脚本别忘了同步)
- 扩展:改完让用户在 `edge://extensions` 点"重新加载";发版用 dist/ 重新打包(命令见 README)
- 脚本常驻副本:`~/Library/Application Support/BookmarkSync/bookmark-sync.py`(launchd 指向它,**不是**仓库里的这份);日志 `~/Library/Logs/bookmark-sync.log`

## 已知边界(如实告知用户,勿悄悄"修复")
- 覆盖式同步会传播删除;两浏览器同窗口期变动,后者胜、前者独有改动丢失
- Safari 只读(脚本),扩展方案下 Safari 完全不在圈内
- 浏览器重启后 File System Access API 的授权会过期(handle 记在 IndexedDB 不丢,但权限回到 prompt,这是 Chromium 防恶意扩展永久持盘的安全设计,扩展无法绕过)。已做一键恢复:过期时新标签页顶部出横幅、设置状态栏出内联按钮,点击 requestPermission 续期后自动同步;requestPermission 必须在用户手势(点击)里调用
