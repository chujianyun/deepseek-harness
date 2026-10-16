#!/usr/bin/env python3
"""发送文本消息到飞书群机器人 webhook，支持 HmacSHA256 签名校验。

用法:
    python3 send_webhook.py --mapping <webhook_mapping.json 绝对路径> --name <服务商或测试群> --file <消息文件路径>
    python3 send_webhook.py --url <webhook_url> --content <消息文本>     # 不签名的 webhook

--mapping 文件格式: {"webhooks": {"<名称>": {"url": "...", "secret": "..."}}}；
脚本自己读取地址与密钥，密钥不出现在命令行里。

签名规则（飞书官方）:
    string_to_sign = f"{timestamp}\\n{secret}"
    sign = base64.b64encode(hmac.new(string_to_sign.encode(), digestmod=hashlib.sha256).digest())
    请求体携带 timestamp 与 sign 字段。

退出码: 0 = 发送成功（HTTP 200 + code=0 + msg=success）；1 = 发送失败或参数/映射文件有误，消息未送达；
2 = 结果不确定（超时、连接中断或响应无法解析），消息可能已送达，不要自动重发。
输出一律 UTF-8。
"""
import argparse
import base64
import hashlib
import hmac
import json
import sys
import time
import urllib.request
import urllib.error


def http_post_json(url, data, timeout=20):
    body = json.dumps(data).encode("utf-8")
    req = urllib.request.Request(
        url, data=body,
        headers={"Content-Type": "application/json; charset=utf-8"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            status = resp.status
            text = resp.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode("utf-8"))
        except Exception:
            return e.code, {"code": e.code, "msg": str(e)}
    except urllib.error.URLError as e:
        if isinstance(e.reason, ConnectionRefusedError):
            return 0, {"code": -1, "msg": str(e)}
        return None, {"code": -1, "msg": str(e)}
    except Exception as e:
        return None, {"code": -1, "msg": str(e)}
    try:
        return status, json.loads(text)
    except ValueError:
        return None, {"code": -1, "msg": f"无法解析的响应: {text[:200]}"}


def build_sign(timestamp, secret):
    string_to_sign = f"{timestamp}\n{secret}"
    digest = hmac.new(string_to_sign.encode("utf-8"), digestmod=hashlib.sha256).digest()
    return base64.b64encode(digest).decode("utf-8")


def fail(message):
    print(message)
    sys.exit(1)


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="发送文本消息到飞书群机器人 webhook")
    parser.add_argument("--url", default=None, help="webhook URL（与 --mapping 二选一）")
    parser.add_argument("--mapping", default=None, help="webhook 映射文件路径（与 --url 二选一）")
    parser.add_argument("--name", default=None, help="映射文件中的服务商或测试群名称")
    parser.add_argument("--content", default=None, help="消息文本（与 --file 二选一）")
    parser.add_argument("--file", default=None, help="消息文本文件路径（与 --content 二选一）")
    args = parser.parse_args()

    url, secret = args.url, None
    if args.mapping:
        if not args.name:
            fail("错误: --mapping 需要同时给出 --name")
        try:
            with open(args.mapping, "r", encoding="utf-8") as f:
                webhooks = json.load(f).get("webhooks")
        except FileNotFoundError:
            fail(f"错误: 缺少 webhook 映射文件 {args.mapping}")
        except (ValueError, AttributeError):
            fail(f"错误: webhook 映射文件 {args.mapping} 不是规定格式的 JSON")
        entry = webhooks.get(args.name) if isinstance(webhooks, dict) else None
        if not isinstance(entry, dict) or not entry.get("url"):
            fail(f"错误: 映射文件里没有「{args.name}」的 webhook")
        url, secret = entry["url"], entry.get("secret")
    if not url:
        print("错误: 必须提供 --url 或 --mapping 与 --name")
        sys.exit(1)

    if args.content:
        text = args.content
    elif args.file:
        with open(args.file, "r", encoding="utf-8") as f:
            text = f.read().strip()
    else:
        print("错误: 必须提供 --content 或 --file")
        sys.exit(1)

    payload = {"msg_type": "text", "content": {"text": text}}

    if secret:
        timestamp = str(int(time.time()))
        payload["timestamp"] = timestamp
        payload["sign"] = build_sign(timestamp, secret)
        print("签名模式")

    status, resp = http_post_json(url, payload)
    print(f"HTTP {status}: {json.dumps(resp, ensure_ascii=False)}")

    if status == 200 and isinstance(resp, dict) and resp.get("code") == 0 and resp.get("msg") == "success":
        print("发送成功")
    elif status is None:
        print("结果不确定：消息可能已送达，不要自动重发")
        sys.exit(2)
    else:
        print("发送失败")
        sys.exit(1)


if __name__ == "__main__":
    main()
