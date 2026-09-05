#!/usr/bin/env python3
"""bookmark-sync.py —— 借助坚果云,在多个浏览器间做"覆盖式"书签同步

模型:
  · 坚果云里只有一个主文件 bookmarks-master.json,内容带 updated_at 时间戳
  · 主文件保存完整收藏夹结构(文件夹层级原样保留)
  · 某浏览器书签有变动 → 以它为最新版本生成新主文件(覆盖旧主文件,
    坚果云平台自会保留历史版本)
  · 其他浏览器(退出状态)被主文件整体覆盖,保证所有浏览器收藏夹一致
  · 首次运行(还没有主文件)把所有浏览器书签做并集合并成初始主文件,
    不丢任何一条;之后就是纯覆盖

安全机制:
  · 写入浏览器文件前先备份为 Bookmarks.sync-backup
  · 浏览器正在运行时不写入(运行中的浏览器退出时会覆盖书签文件)
  · 只同步"收藏夹栏"与"其他收藏夹";Safari 只读不写
"""

import copy
import json
import os
import plistlib
import shutil
import subprocess
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

HOME = Path.home()
IS_MAC = sys.platform == "darwin"
IS_WIN = sys.platform == "win32"
IS_LINUX = sys.platform.startswith("linux")


# 坚果云同步目录:各平台客户端默认位置不同,按候选列表自动探测;都找不到时用 BMSYNC_STORE_DIR 指定
def _store_candidates():
    if IS_WIN:
        return [Path.home() / "我的坚果云" / "书签同步",
                Path.home() / "Nutstore Files" / "我的坚果云" / "书签同步"]
    if IS_LINUX:
        return [Path.home() / "Nutstore Files" / "我的坚果云" / "书签同步",
                Path.home() / "坚果云同步目录" / "书签同步"]
    return [Path.home() / "Nutstore Files" / "我的坚果云" / "书签同步"]


def _default_store_dir():
    cands = _store_candidates()
    for c in cands:
        if c.exists():
            return c
    return cands[0]


NUTSTORE_DIR = Path(os.environ.get("BMSYNC_STORE_DIR", str(_default_store_dir())))
MASTER_FILE = NUTSTORE_DIR / "bookmarks-master.json"

if IS_MAC:
    STATE_DIR = Path(os.environ.get(
        "BMSYNC_STATE_DIR", str(HOME / "Library" / "Application Support" / "BookmarkSync")))
else:  # Windows → %APPDATA%\BookmarkSync;Linux → ~/.config/bookmark-sync
    _base = os.environ.get("APPDATA") if IS_WIN else str(HOME / ".config")
    STATE_DIR = Path(os.environ.get("BMSYNC_STATE_DIR", str(Path(_base) / "BookmarkSync")))


# 各平台的 Chromium 系浏览器:数据目录 + 进程名(会自动发现其下所有 Profile)
def _chromium_browsers():
    if IS_WIN:
        la = Path(os.environ.get("LOCALAPPDATA", str(HOME / "AppData/Local")))
        return [
            {"name": "Edge",   "data_dir": la / "Microsoft/Edge", "process": "msedge.exe"},
            {"name": "Chrome", "data_dir": la / "Google/Chrome",  "process": "chrome.exe"},
        ]
    if IS_LINUX:
        return [
            {"name": "Edge",     "data_dir": HOME / ".config/microsoft-edge", "process": "msedge"},
            {"name": "Chrome",   "data_dir": HOME / ".config/google-chrome",  "process": "chrome"},
            {"name": "Chromium", "data_dir": HOME / ".config/chromium",       "process": "chromium"},
        ]
    return [  # macOS
        {"name": "Edge",   "data_dir": HOME / "Library/Application Support/Microsoft Edge", "process": "Microsoft Edge"},
        {"name": "Chrome", "data_dir": HOME / "Library/Application Support/Google/Chrome",  "process": "Google Chrome"},
        {"name": "Quark",  "data_dir": HOME / "Library/Application Support/Quark",          "process": "Quark"},
    ]


SAFARI = {  # 只读不写;仅 macOS
    "name": "Safari",
    "bookmarks": HOME / "Library/Safari/Bookmarks.plist",
    "process": "Safari",
    "kind": "safari",
    "import": False,
}

log_lines = []


def log(msg):
    line = f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {msg}"
    log_lines.append(line)
    print(line)


def flush_log():
    try:
        p = (HOME / "Library/Logs/bookmark-sync.log") if IS_MAC \
            else (STATE_DIR / "bookmark-sync.log")
        p.parent.mkdir(parents=True, exist_ok=True)
        with open(p, "a", encoding="utf-8") as f:
            f.write("\n".join(log_lines) + "\n")
    except OSError:
        pass


# ---------- 浏览器发现 ----------
def discover_browsers():
    out = []
    for b in _chromium_browsers():
        base = Path(b["data_dir"])
        if not base.exists():
            continue
        try:
            profiles = sorted(p for p in base.iterdir()
                              if p.is_dir() and (p.name == "Default" or p.name.startswith("Profile ")))
        except OSError:
            continue
        for p in profiles:
            if (p / "Bookmarks").is_file():
                label = b["name"] if p.name == "Default" else f"{b['name']}-{p.name}"
                out.append({"name": label, "bookmarks": str(p / "Bookmarks"),
                            "process": b["process"], "kind": "chromium"})
    if IS_MAC and Path(SAFARI["bookmarks"]).exists():
        out.append(dict(SAFARI))
    return out


def load_browsers():
    cfg = os.environ.get("BMSYNC_CONFIG")
    if cfg and Path(cfg).exists():
        with open(cfg, encoding="utf-8") as f:
            log(f"使用测试配置:{cfg}")
            return json.load(f)["browsers"]
    return discover_browsers()


# ---------- 读取各格式书签 ----------
def norm_url(u):
    if not u:
        return ""
    try:
        parts = urlsplit(u.strip())
        path = parts.path or "/"
        if path != "/" and path.endswith("/"):
            path = path.rstrip("/")
        return urlunsplit((parts.scheme.lower(), parts.netloc.lower(), path, parts.query, ""))
    except ValueError:
        return u.strip()


def read_chromium(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def read_safari(path):
    with open(path, "rb") as f:
        return plistlib.load(f)


def read_browser(b):
    p = Path(b["bookmarks"])
    if not p.exists():
        return None
    try:
        return read_safari(p) if b.get("kind") == "safari" else read_chromium(p)
    except Exception as e:
        log(f"[{b['name']}] 读取失败:{e}")
        return None


def chromium_bar_other(tree):
    roots = tree.get("roots", {})
    bar = roots.get("bookmark_bar") or {}
    other = roots.get("other") or {}
    return bar.get("children", []) or [], other.get("children", []) or []


def safari_bar_other(plist):
    """Safari plist → (收藏夹栏, 其他),节点转成 Chromium 风格"""

    def convert(node):
        ntype = node.get("WebBookmarkType")
        if ntype == "WebBookmarkTypeLeaf":
            return {"type": "url", "name": node.get("URIDictionary", {}).get("title", ""),
                    "url": node.get("URLString", "")}
        if ntype == "WebBookmarkTypeList":
            return {"type": "folder", "name": node.get("Title", ""),
                    "children": [convert(c) for c in node.get("Children", [])]}
        return None

    def find_title(node, title):
        for ch in node.get("Children", []):
            if ch.get("Title") == title:
                return ch
        return {}

    bar = convert(find_title(plist, "BookmarksBar")) or {"children": []}
    other = convert(find_title(plist, "BookmarksMenu")) or {"children": []}
    return bar.get("children", []), other.get("children", [])


def bar_other_of(b, raw):
    return safari_bar_other(raw) if b.get("kind") == "safari" else chromium_bar_other(raw)


def signature(bar, other):
    """结构签名:只看 类型/名称/URL/层级,忽略 id、guid、日期等易变字段"""
    def clean(nodes):
        out = []
        for n in nodes:
            if n.get("type") == "url":
                out.append({"u": norm_url(n.get("url", "")), "n": n.get("name", "")})
            else:
                out.append({"n": n.get("name", ""), "c": clean(n.get("children", []))})
        return out
    return json.dumps([clean(bar), clean(other)], ensure_ascii=False, sort_keys=True)


def collect_urls(nodes, out):
    for n in nodes:
        if n.get("type") == "url":
            out.add(norm_url(n.get("url", "")))
        else:
            collect_urls(n.get("children", []), out)


# ---------- 主文件 ----------
def now_iso():
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="microseconds")


def load_master():
    if MASTER_FILE.exists():
        try:
            with open(MASTER_FILE, encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            backup = MASTER_FILE.with_suffix(".json.corrupt")
            MASTER_FILE.replace(backup)
            log(f"主文件损坏({e}),已备份为 {backup.name},将重新生成")
    return None


def save_master(master):
    master["revision"] = int(master.get("revision", 0)) + 1  # 单调递增,作为版本判据
    master["updated_at"] = now_iso()
    NUTSTORE_DIR.mkdir(parents=True, exist_ok=True)
    tmp = MASTER_FILE.with_suffix(".json.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(master, f, ensure_ascii=False, indent=2)
    os.replace(tmp, MASTER_FILE)


def master_from_tree(bar, other, source):
    return {"version": 2, "updated_at": now_iso(), "source": source,
            "roots": {"bookmark_bar": copy.deepcopy(bar), "other": copy.deepcopy(other)}}


def union_master(sources):
    """sources: [(name, bar, other)],按新旧排序。并集合并,保留文件夹层级,重复 URL 取最新的"""
    master_bar, master_other = [], []
    seen = set()

    def ensure_folder(children, name):
        for ch in children:
            if ch.get("type") == "folder" and ch.get("name") == name:
                return ch
        node = {"type": "folder", "name": name, "children": []}
        children.append(node)
        return node

    def merge(nodes, dst):
        for n in nodes:
            if n.get("type") == "url":
                u = norm_url(n.get("url", ""))
                if not u or u in seen:
                    continue
                seen.add(u)
                dst.append({"type": "url", "name": n.get("name", ""), "url": n.get("url", "")})
            elif n.get("type") == "folder":
                merge(n.get("children", []), ensure_folder(dst, n.get("name", "")).get("children"))

    for name, bar, other in sources:
        merge(bar, master_bar)
        merge(other, master_other)
    return {"version": 2, "updated_at": now_iso(),
            "source": f"初次并集({', '.join(s[0] for s in sources)})",
            "roots": {"bookmark_bar": master_bar, "other": master_other}}


# ---------- 覆盖写入 Chromium ----------
def chromium_time_now():
    epoch = datetime(1601, 1, 1, tzinfo=timezone.utc)
    return str(int((datetime.now(timezone.utc) - epoch).total_seconds() * 1_000_000))


def apply_master(tree, master):
    """主文件的收藏夹栏/其他收藏夹 整体覆盖进浏览器书签树,并重编 id"""
    roots = tree.setdefault("roots", {})

    def ensure_root(key, name):
        node = roots.get(key)
        if not isinstance(node, dict):
            node = {"children": [], "date_added": chromium_time_now(), "date_modified": "0",
                    "guid": str(uuid.uuid4()), "id": "0", "name": name, "type": "folder"}
            roots[key] = node
        return node

    ensure_root("bookmark_bar", "收藏夹栏")["children"] = copy.deepcopy(master["roots"]["bookmark_bar"])
    ensure_root("other", "其他收藏夹")["children"] = copy.deepcopy(master["roots"]["other"])

    counter = [1]

    def renumber(node):
        node["id"] = str(counter[0])
        counter[0] += 1
        if node.get("type") == "folder":
            for ch in node.get("children", []):
                renumber(ch)
        else:
            node.setdefault("guid", str(uuid.uuid4()))
            node.setdefault("date_added", chromium_time_now())

    for key in ("bookmark_bar", "other", "synced"):
        node = roots.get(key)
        if isinstance(node, dict):
            renumber(node)
    tree.pop("checksum", None)


def write_browser(b, tree):
    p = Path(b["bookmarks"])
    shutil.copy2(p, p.with_name(p.name + ".sync-backup"))
    tmp = p.with_name(p.name + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(tree, f, ensure_ascii=False)
    os.replace(tmp, p)


def process_running(name):
    if IS_WIN:
        r = subprocess.run(["tasklist", "/FI", f"IMAGENAME eq {name}", "/NH"],
                           capture_output=True, text=True)
        return name.lower() in (r.stdout or "").lower()
    return subprocess.run(["pgrep", "-x", name], capture_output=True).returncode == 0


# ---------- 快照 ----------
def snapshot_file(name):
    return STATE_DIR / f"{name}.snapshot.json"


def read_snapshot(name):
    f = snapshot_file(name)
    if f.exists():
        try:
            with open(f, encoding="utf-8") as fh:
                return json.load(fh)
        except Exception:
            pass
    return {}


def write_snapshot(name, sig, master):
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    with open(snapshot_file(name), "w", encoding="utf-8") as f:
        json.dump({"signature": sig, "synced_master_rev": master.get("revision", 0)},
                  f, ensure_ascii=False)


# ---------- 主流程 ----------
def main():
    if not NUTSTORE_DIR.exists():
        log(f"坚果云目录不存在:{NUTSTORE_DIR}")
        return 1
    STATE_DIR.mkdir(parents=True, exist_ok=True)

    browsers = load_browsers()
    entries = []
    for b in browsers:
        raw = read_browser(b)
        if raw is None:
            log(f"[{b['name']}] 书签文件不存在,跳过")
            continue
        bar, other = bar_other_of(b, raw)
        entries.append({"b": b, "raw": raw, "bar": bar, "other": other,
                        "sig": signature(bar, other),
                        "mtime": Path(b["bookmarks"]).stat().st_mtime})

    master = load_master()
    snaps = {e["b"]["name"]: read_snapshot(e["b"]["name"]) for e in entries}
    changed = [e for e in entries if e["sig"] != snaps[e["b"]["name"]].get("signature")]

    # 1) 生成 / 更新主文件
    if master is None:
        ordered = sorted(entries, key=lambda e: -e["mtime"])
        master = union_master([(e["b"]["name"], e["bar"], e["other"]) for e in ordered])
        save_master(master)
        log(f"首次运行:并集合并 {', '.join(e['b']['name'] for e in ordered)} → 初始主文件已生成")
    elif changed:
        chromium_changed = [e for e in changed if e["b"].get("kind") != "safari"]
        if chromium_changed:
            winner = max(chromium_changed, key=lambda e: e["mtime"])
            prev_rev = int(master.get("revision", 0))
            master = master_from_tree(winner["bar"], winner["other"], winner["b"]["name"])
            master["revision"] = prev_rev
            save_master(master)
            log(f"[{winner['b']['name']}] 有变动 → 主文件已更新({master['updated_at']})")
        else:
            log("仅 Safari 有变动(只读,不影响主文件)")
    else:
        log(f"无本地变动,沿用主文件 {master['updated_at']}")

    total = set()
    collect_urls(master["roots"]["bookmark_bar"], total)
    collect_urls(master["roots"]["other"], total)

    # 2) 覆盖到各浏览器
    source_name = master.get("source", "")
    for e in entries:
        b = e["b"]
        if b.get("kind") == "safari":
            write_snapshot(b["name"], e["sig"], master)
            continue
        if b["name"] == source_name:
            # 来源浏览器的内容就是主文件内容,只需登记快照
            write_snapshot(b["name"], e["sig"], master)
            continue
        snap = snaps[b["name"]]
        need = (e["sig"] != snap.get("signature")) or \
               (snap.get("synced_master_rev") != master.get("revision"))
        if not need:
            continue
        if process_running(b["process"]):
            log(f"[{b['name']}] 正在运行,覆盖写入推迟到它退出后(共 {len(total)} 条待写入)")
            continue
        apply_master(e["raw"], master)
        write_browser(b, e["raw"])
        write_snapshot(b["name"],
                       signature(master["roots"]["bookmark_bar"], master["roots"]["other"]),
                       master)
        log(f"[{b['name']}] 已覆盖为最新主文件(共 {len(total)} 条,备份: Bookmarks.sync-backup)")

    log(f"完成。主文件: {MASTER_FILE} ({master['updated_at']}, 共 {len(total)} 条)")
    return 0


if __name__ == "__main__":
    try:
        code = main()
    except Exception as e:
        log(f"异常退出:{e}")
        code = 1
    flush_log()
    sys.exit(code)
