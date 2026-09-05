# 书签主页 + 坚果云书签同步

两个配套组件:一个把浏览器收藏夹变成好看的新标签页的 **Edge/Chrome 扩展**(内置坚果云书签同步),以及一个可选的**独立 Python 同步脚本**。核心思路:坚果云同步文件夹里放一个带时间戳和版本号的主文件 `bookmarks-master.json`,所有浏览器(或同一台机器上的多个浏览器)都以它为准做**覆盖式同步**,文件夹层级原样保留。

> 本文件夹是「临时项目」工作区里的一个独立项目。工作区根目录的 `README.md` 是所有项目的索引。

## 目录结构

```
bookmark-homepage-suite/         # ★ 项目根(本文件所在)
├── bookmark-homepage/     # 浏览器扩展(MV3,无构建步骤,原生 JS)
│   ├── manifest.json      # 权限:bookmarks / favicon / storage
│   ├── newtab.html        # 新标签页入口(chrome_url_overrides 接管)
│   ├── newtab.js          # 收藏夹渲染、搜索下拉、主题、壁纸、设置
│   ├── sync.js            # 坚果云书签同步模块(File System Access API)
│   ├── style.css
│   └── icons/             # 扩展图标(gen_icons.py 可重新生成)
├── bookmark-sync/         # 独立脚本版同步(可选,Python 仅标准库)
│   ├── bookmark-sync.py   # 同步引擎:读各浏览器书签 → 主文件 → 覆盖回写
│   └── install.sh         # 安装为 launchd 常驻任务(每 30 秒一轮)
└── dist/                  # 打包产物:crx / pem(私钥,勿丢)/ zip(商店提交用)
```

## 扩展:书签主页

**安装(开发模式)**:Edge 打开 `edge://extensions` → 开启「开发人员模式」→「加载解压缩的扩展」→ 选择 `bookmark-homepage` 文件夹 → 新开标签页即可。⚠️ 文件夹别移动或删除,解压缩加载的扩展一直引用它。

**功能**:

- 收藏夹卡片化展示,4 种文件夹卡片样式可切换(图标组 / 单图标 / 层叠 / 文件夹)
- 分类、面包屑导航、搜索框(搜收藏下拉建议 + 网址直开 + 回车必应搜索)
- 网站头像直接落在液态玻璃卡片上,加载失败退化为渐变字母块
- 壁纸:上传本地图片 / 在线地址 / 默认渐变;文字颜色随壁纸明暗自动翻转
- 每次打开新标签页自动同步坚果云书签(可关)

**打包**:

```bash
# crx(用 dist/bookmark-homepage.pem 保持扩展 ID 不变)
"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" \
  --pack-extension="$PWD/bookmark-homepage" --pack-extension-key="$PWD/dist/bookmark-homepage.pem"
# 商店提交用 zip(在 bookmark-homepage/ 内执行)
zip -qr ../dist/bookmark-homepage.zip . -x "*.DS_Store" -x "icons/gen_icons.py"
```

## 同步模型(两个组件通用)

坚果云文件夹里只有一个主文件 `bookmarks-master.json`:

```json
{
  "version": 2,
  "updated_at": "2026-09-05T14:17:19.469354+08:00",
  "revision": 4,
  "source": "Chrome",
  "roots": {
    "bookmark_bar": [ { "type": "folder", "name": "编程与开发", "children": [ … ] } ],
    "other": []
  }
}
```

- 节点只有两种:`{"type":"url","name","url"}` 和 `{"type":"folder","name","children"}`;**不含 id/guid/日期**(那些是各浏览器自己的,写入时重编)
- `revision` 单调递增,是"谁新谁旧"的唯一判据;`updated_at` 仅展示
- **同步逻辑是覆盖**:某浏览器书签有变动 → 它成为最新版本生成新主文件(revision+1)→ 其他浏览器整体覆盖成与主文件一致
- 首次接入/首次运行做一次**并集合并**成初始主文件,保证不丢书签;之后就是纯覆盖
- 覆盖写浏览器前自动备份(脚本:`Bookmarks.sync-backup`;扩展:文件夹内 `bookmarks-backup-*.json`,保留 5 份)

### 两种形态

| | 扩展内置同步(sync.js) | 独立脚本(bookmark-sync.py) |
|---|---|---|
| 运行方式 | 打开新标签页时自动(5 分钟节流)+ 手动 | launchd 每 30 秒 |
| 写本浏览器 | `chrome.bookmarks` API,**浏览器无需退出** | 直接改书签文件,**浏览器必须退出** |
| 覆盖范围 | 本浏览器(装了扩展的) | 全部 Chromium 系 + Safari(只读) |
| 依赖 | 授权坚果云文件夹(File System Access API) | python3,无需授权 |

**两者不要同时开**(会对同一主文件互相刷版本)。当前状态:launchd 脚本已暂停,推荐用扩展内置同步;想恢复脚本:

```bash
launchctl load ~/Library/LaunchAgents/com.wuhang.bookmark-sync.plist
```

### 使用步骤(扩展版)

1. 新标签页 → 右下角 ⚙ →「选择坚果云文件夹」→ 选坚果云的「书签同步」文件夹
2. 首次接入以现有主文件为准覆盖本地(自动备份旧书签)
3. 之后每次打开新标签页自动同步;其他电脑/浏览器装同一扩展做同样授权即可

## 独立脚本(可选)

```bash
bookmark-sync/install.sh        # 安装常驻任务并立即跑一轮
tail ~/Library/Logs/bookmark-sync.log   # 看日志
launchctl unload ~/Library/LaunchAgents/com.wuhang.bookmark-sync.plist && \
  rm ~/Library/LaunchAgents/com.wuhang.bookmark-sync.plist   # 卸载
```

浏览器清单自动发现(Edge / Chrome / 夸克 的所有 Profile;Safari 只读)。浏览器**正在运行时只读不写**——写入推迟到它退出后的下一个周期,防止运行中的浏览器退出时覆盖书签文件。

## 跨平台支持

**扩展**:Windows / Linux / macOS 的 Edge 与 Chrome(含其他 Chromium 系)均可使用,功能完全一致——包括坚果云同步(File System Access API 三平台都支持)。换电脑:复制 `bookmark-homepage/` 文件夹 → 加载解压缩 → 授权坚果云文件夹即可。

**独立脚本**:三平台自适应,自动识别系统、浏览器数据目录与进程检测方式:

| 平台 | 浏览器数据目录 | 进程检测 | 常驻方式 |
|---|---|---|---|
| macOS | `~/Library/Application Support/<浏览器>` | `pgrep -x` | launchd(`install.sh`) |
| Windows | `%LOCALAPPDATA%\<浏览器>`(如 `Microsoft/Edge`) | `tasklist /FI` | 任务计划程序:`schtasks /Create /SC MINUTE /MO 1 /TN BookmarkSync /TR "python 路径\bookmark-sync.py"` |
| Linux | `~/.config/<浏览器>`(如 `google-chrome`、`microsoft-edge`、`chromium`) | `pgrep -x` | crontab 加一行 `*/1 * * * * python3 …/bookmark-sync.py`,或 systemd user timer |

坚果云同步目录各平台客户端默认位置不同,脚本按候选列表自动探测;探测不到时用环境变量 `BMSYNC_STORE_DIR` 手动指定。Safari 相关能力仅 macOS。

## 常见问题

- **误删书签怎么恢复**:覆盖式同步会传播删除。找 `Bookmarks.sync-backup`(脚本写入前备份)或坚果云文件夹里的 `bookmarks-backup-*.json`
- **两台电脑同时变了怎么办**:以文件修改时间新的为准,另一方的独有改动会被覆盖(这是"覆盖"语义的代价)
- **Chrome 数据目录**:macOS 上是 `~/Library/Application Support/Google/Chrome`(注意是 `Google/Chrome` 两级,不是 `Google Chrome`)
- **主文件损坏**:脚本会自动改名 `.json.corrupt` 并重新生成;坚果云平台本身保留历史版本可回滚
