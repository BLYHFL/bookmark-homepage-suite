#!/bin/bash
# 安装/更新 书签同步 常驻任务(launchd 每 30 秒运行一次)
set -e

SRC="$(cd "$(dirname "$0")" && pwd)/bookmark-sync.py"
DEST_DIR="$HOME/Library/Application Support/BookmarkSync"
PLIST="$HOME/Library/LaunchAgents/com.wuhang.bookmark-sync.plist"
PYTHON="$(command -v python3)"

[ -f "$SRC" ] || { echo "找不到 bookmark-sync.py"; exit 1; }
[ -n "$PYTHON" ] || { echo "找不到 python3"; exit 1; }

mkdir -p "$DEST_DIR" "$HOME/Library/Logs" "$HOME/Library/LaunchAgents"
cp "$SRC" "$DEST_DIR/bookmark-sync.py"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.wuhang.bookmark-sync</string>
    <key>ProgramArguments</key>
    <array>
        <string>$PYTHON</string>
        <string>$DEST_DIR/bookmark-sync.py</string>
    </array>
    <key>StartInterval</key>
    <integer>30</integer>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$HOME/Library/Logs/bookmark-sync.log</string>
    <key>StandardErrorPath</key>
    <string>$HOME/Library/Logs/bookmark-sync.log</string>
</dict>
</plist>
EOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "✅ 已安装并启动:每 30 秒自动同步一次"
echo "   脚本位置:$DEST_DIR/bookmark-sync.py"
echo "   日志:    ~/Library/Logs/bookmark-sync.log"
echo "   卸载:    launchctl unload $PLIST && rm $PLIST"
