/** The stand-in lark-cli shared by the connector specs and the Web e2e. */

/**
 * A shell script that prints what the real lark-cli prints at each sign-in step. Its control files
 * live in `../control` beside its version directory: `config init` and `auth login` print their
 * address and wait for `control/app` or `control/user` to say `ok` or `fail:<message>`; `auth status`
 * answers from the tenant's configuration unless `control/status.json` overrides it; errors go to
 * stderr as the real CLI's do; every call is logged to `control/calls`.
 */
export const FAKE_LARK_CLI = String.raw`#!/bin/sh
C="$(cd "$(dirname "$0")" && pwd)/../control"
CFG="$LARKSUITE_CLI_CONFIG_DIR"
mkdir -p "$C"
echo "$*" >> "$C/calls"
await() { while [ ! -f "$1" ]; do sleep 0.05; done; r=$(cat "$1"); m=$(printf %s "$r" | cut -c6-); rm -f "$1"; }
case "$1 $2" in
  "--version ") echo "lark-cli version 9.9.9" ;;
  "config init")
    env | grep -E '^(LARKSUITE_CLI_|OPENCLAW_HOME|HERMES_HOME)' | sort > "$C/env"
    echo "█▀▄ QR █▀▄" >&2
    echo "打开以下链接配置应用:" >&2
    echo "  https://open.feishu.cn/page/cli?user_code=APP-1" >&2
    await "$C/app"
    if [ "$r" = ok ]; then mkdir -p "$CFG"; echo '{}' > "$CFG/config.json"; exit 0; fi
    echo "{\"ok\":false,\"error\":{\"type\":\"api\",\"message\":\"$m\"}}" >&2; exit 1 ;;
  "auth login")
    echo '{"event":"scopes_resolved"}'
    sleep 0.1
    echo '{"event":"device_authorization","verification_uri":"https://accounts.feishu.cn/verify","verification_uri_complete":"https://accounts.feishu.cn/verify?user_code=USER-1","user_code":"USER-1","expires_in":600}'
    await "$C/user"
    if [ "$r" = ok ]; then echo 韩梅梅 > "$CFG/user"; echo '{"event":"authorization_success"}'; exit 0; fi
    echo "{\"event\":\"authorization_failed\",\"error\":\"$m\"}"; exit 2 ;;
  "auth status")
    if [ -f "$C/status.json" ]; then cat "$C/status.json"; exit 0; fi
    if [ ! -f "$CFG/config.json" ]; then echo '{"ok":false,"error":{"type":"config","subtype":"not_configured","message":"not configured"}}' >&2; exit 3; fi
    if [ -f "$CFG/user" ]; then printf '{"identities":{"user":{"status":"ready","userName":"%s"}}}\n' "$(cat "$CFG/user")"
    else echo '{"identities":{"user":{"status":"missing","message":"User identity: missing (no user logged in)"}}}'; fi ;;
  "auth qrcode")
    if [ -f "$C/noqr" ]; then exit 1; fi
    printf 'PNG' > "$5" ;;
  "config remove") rm -rf "$CFG" ;;
esac
`
