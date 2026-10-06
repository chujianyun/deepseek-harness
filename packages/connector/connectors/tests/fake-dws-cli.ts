/** The stand-in dws shared by the connector specs and the Web e2e. */

/**
 * A shell script that prints what the real dws prints. Its control files live in `../control`
 * beside its version directory: `auth login --device` prints the device-flow address on stderr and
 * waits for `control/user` to say `ok` (signed in to the tenant's configuration) or
 * `fail:<message>`; `auth status --readonly --format json` answers from the tenant's configuration
 * unless `control/status.json` overrides it; `auth logout` signs out; `--help` states the Safety of
 * `calendar event list` (read), `chat message send` (write), and `doc delete` (destructive, which
 * runs only with `--yes` or `-y`); `calendar event list` succeeds and `calendar event fail` fails.
 * `calendar event` takes `.data.lock` in the configuration directory, as the real dws does. Every call is logged to
 * `control/calls`, and a business command records its `DWS_*` variables in `control/run-env`.
 */
export const FAKE_DWS = String.raw`#!/bin/sh
C="$(cd "$(dirname "$0")" && pwd)/../control"
CFG="$DWS_CONFIG_DIR"
mkdir -p "$C"
echo "$*" >> "$C/calls"
await() { while [ ! -f "$1" ]; do sleep 0.05; done; r=$(cat "$1"); m=$(printf %s "$r" | cut -c6-); rm -f "$1"; }
case " $* " in
  *" --help "*)
    case "$1 $2 $3" in
      "calendar event list") echo "Usage: dws calendar event list"; echo; echo "Safety: effect=read  risk=low  confirmation=not_required  idempotency=idempotent" ;;
      "chat message send") echo "Safety: effect=write  risk=medium  confirmation=not_required  idempotency=unknown" ;;
      "doc delete --help") echo "Safety: effect=destructive  risk=high  confirmation=user_required  idempotency=unknown" ;;
      *) echo "Usage: dws $1" ;;
    esac
    exit 0 ;;
esac
case "$1 $2" in
  "--version ") echo "dws version v9.9.9 (abc, 2026-10-03)" ;;
  "auth login")
    env | grep -E '^DWS_' | sort > "$C/env"
    echo "● Step 1: Requesting device authorization code..." >&2
    echo "  Authorization link (code included):" >&2
    echo "https://login.dingtalk.com/oauth2/device/verify.htm?caller=dws&user_code=DING-1" >&2
    await "$C/user"
    if [ "$r" = ok ]; then mkdir -p "$CFG"; echo 韩梅梅 > "$CFG/user"; echo '{"success":true,"message":"登录成功","user_name":"韩梅梅"}'; exit 0; fi
    printf '{"error":{"category":"auth","message":"%s"}}\n' "$m" >&2; exit 1 ;;
  "auth status")
    if [ -f "$C/status.json" ]; then cat "$C/status.json"; exit 0; fi
    if [ -f "$CFG/user" ]; then printf '{"success":true,"authenticated":true,"user_name":"%s","corp_name":"甲公司"}\n' "$(cat "$CFG/user")"
    else echo '{"success":true,"authenticated":false,"message":"未登录"}'; fi ;;
  "auth logout") rm -f "$CFG/user"; echo "[OK] 已清除认证信息" ;;
  "calendar event")
    # As the real dws, a call that reads the sign-in takes a lock file in the configuration directory.
    if ! : > "$CFG/.data.lock"; then echo '{"error":{"message":"opening lock file: operation not permitted"}}' >&2; exit 5; fi
    env | grep -E '^DWS_' | sort > "$C/run-env"
    if [ "$3" = fail ]; then echo '{"error":{"message":"permission denied"}}' >&2; exit 4; fi
    echo '{"events":[{"summary":"钉钉周会","start":"14:00"}]}' ;;
  "chat message") echo '{"messageId":"msg_sent"}' ;;
  "doc delete")
    case " $* " in *" --yes "*|*" -y "*) echo '{"deleted":true}' ;; *) echo '{"error":{"message":"confirmation required: pass --yes"}}' >&2; exit 2 ;; esac ;;
esac
`
