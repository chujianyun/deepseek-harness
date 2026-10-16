#!/usr/bin/env python3
"""云台每日补采的计算：找缺口日期、按账户名归类服务商、去掉表里已有的记录、生成写入文件、写后核对。

用法:
    python3 collect_plan.py gap    --records <目录> --to <YYYY-MM-DD> [--checkpoint <checkpoint.json>]
    python3 collect_plan.py plan   --accounts <账户明细.json> --tables <tables.json> --records <目录> --out <目录>
    python3 collect_plan.py verify --plan <plan.json> --records <目录>

<目录> 下是各服务商表的 `lark-cli base +record-list --format json` 输出，文件名以「服务商-」开头（如 在达-0.json）；
<账户明细.json> 是 yuntai-details 的 yuntai-accounts.mjs 输出；
<tables.json> 是 {"base_token": "…", "tables": {"<服务商>": "<table_id>", …}}，取自配置文档「数据源映射」。

gap: 断点 = checkpoint 的 breakpoint（某天整天写完并核对通过才前移）；没有 checkpoint 时取各表最大日期中最晚的一天。
     打印断点之后到 --to 的日期（最多 14 天）。某天只写进了部分表时断点不动，下次重跑这天，表里已有的记录自动跳过。
plan: 账户行四项合计与总计行对不上 → 退出 2，不写；否则按服务商写 batch-<服务商>.json（+record-batch-create --json 用），
      表里已有同一天同一账户id 的跳过；自营（名称含 -ML-）和认不出服务商的账户不写，列在 plan.json 里。
verify: 计划写入的每一条在表里恰好一条；一致退出 0，否则 1。
其他退出码：2 = 输入有误。
"""
import argparse
import datetime
import json
import os
import re
import sys

#: 账户名特征 → 服务商，按顺序匹配第一条。
PROVIDERS = [
    (re.compile(r"-ML-"), "自营"),
    (re.compile(r"豹擎"), "豹擎"),
    (re.compile(r"道有道|CID-"), "道有道"),
    (re.compile(r"剧星"), "剧星"),
    (re.compile(r"声势"), "声势"),
    (re.compile(r"旋龟"), "旋龟"),
    (re.compile(r"耀阳"), "耀阳"),
    (re.compile(r"青出蓝"), "青出蓝"),
    (re.compile(r"在达"), "在达"),
    (re.compile(r"大小无忧"), "大小无忧"),
]
FIELDS = ["账户id", "账户名称", "投放平台", "日期", "消耗", "总GMV", "有效GMV", "退款率", "退款金额"]
MAX_GAP = 14
BATCH = 200
BEIJING = datetime.timezone(datetime.timedelta(hours=8))


class InputError(Exception):
    """输入文件不对。"""


def read_json(path):
    """读 JSON 文件；PowerShell 5.1 重定向写出的 UTF-16 也能读。"""
    try:
        with open(path, "rb") as f:
            raw = f.read()
    except OSError as e:
        raise InputError(f"读不了 {path}：{e}")
    text = raw.decode("utf-16") if raw[:2] in (b"\xff\xfe", b"\xfe\xff") else raw.decode("utf-8-sig")
    try:
        return json.loads(text)
    except ValueError as e:
        raise InputError(f"{path} 不是 JSON：{e}")


def provider_of(name):
    return next((provider for pattern, provider in PROVIDERS if pattern.search(name)), None)


def text_of(value):
    """单元格的文字：多维表格的文本可能是字符串，也可能是 [{"text": …}] 片段。"""
    if isinstance(value, list):
        return "".join(text_of(part) for part in value)
    if isinstance(value, dict):
        return str(value.get("text", value.get("name", "")))
    return "" if value is None else str(value)


def date_of(value):
    """日期单元格：毫秒时间戳（按北京时间）、或以 YYYY-MM-DD 开头的文字；其他为 None。"""
    if isinstance(value, list) and value:
        value = value[0]
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        return datetime.datetime.fromtimestamp(value / 1000, BEIJING).date()
    match = re.match(r"(\d{4})[-/](\d{1,2})[-/](\d{1,2})", text_of(value).strip())
    return datetime.date(*map(int, match.groups())) if match else None


def records_in(node):
    """JSON 里所有带「账户id」的记录。认得两种写法：+record-list 的矩阵（fields 是列名、data 是按列对齐的行），
    以及字段直接在记录上或在 fields 字典下的写法。"""
    if isinstance(node, dict):
        names, rows = node.get("fields"), node.get("data")
        if isinstance(names, list) and "账户id" in names and isinstance(rows, list):
            for row in rows:
                if isinstance(row, list):
                    yield dict(zip(names, row))
            return
        fields = node.get("fields") if isinstance(node.get("fields"), dict) else node
        if "账户id" in fields:
            yield fields
            return
        for value in node.values():
            yield from records_in(value)
    elif isinstance(node, list):
        for value in node:
            yield from records_in(value)


def table_records(directory):
    """{服务商: [(日期, 账户id), …]}，按文件名前缀分表。"""
    if not os.path.isdir(directory):
        raise InputError(f"没有记录目录 {directory}。")
    tables = {}
    for name in sorted(os.listdir(directory)):
        if not name.endswith(".json") or "-" not in name:
            continue
        provider = name.split("-", 1)[0]
        rows = tables.setdefault(provider, [])
        for record in records_in(read_json(os.path.join(directory, name))):
            rows.append((date_of(record.get("日期")), text_of(record.get("账户id")).strip()))
    return tables


def gap(args):
    to = parse_day(args.to)
    tables = table_records(args.records)
    per_table = {provider: max((d for d, _ in rows if d), default=None) for provider, rows in tables.items()}
    days = [d for d in per_table.values() if d]
    if args.checkpoint and os.path.exists(args.checkpoint):
        mark = parse_day(str(read_json(args.checkpoint).get("breakpoint") or "")[:10], quiet=True)
        if mark:
            days = [mark]
    breakpoint = max(days) if days else None
    first = max(breakpoint + datetime.timedelta(days=1), to - datetime.timedelta(days=MAX_GAP - 1)) if breakpoint else to
    pending = [(first + datetime.timedelta(days=n)).isoformat() for n in range((to - first).days + 1)]
    print(json.dumps({
        "breakpoint": breakpoint.isoformat() if breakpoint else None,
        "per_table_max": {p: d.isoformat() if d else None for p, d in sorted(per_table.items())},
        "pending": pending,
    }, ensure_ascii=False))
    return 0


def parse_day(text, quiet=False):
    """YYYY-MM-DD 的日期；不是时 quiet 返回 None，否则报输入有误。"""
    day = None
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", text):
        try:
            day = datetime.date.fromisoformat(text)
        except ValueError:
            day = None
    if day is None and not quiet:
        raise InputError(f"日期要写成 YYYY-MM-DD，收到 {text}")
    return day


def plan(args):
    printed = read_json(args.accounts)
    data = printed.get("data", printed) if isinstance(printed, dict) else None
    if not isinstance(data, dict) or not isinstance(data.get("accounts"), list):
        raise InputError(f"{args.accounts} 不是 yuntai-accounts.mjs 的输出。")
    if not data.get("check"):
        raise InputError("账户明细里没有和总计行的对账结果（check），不写。")
    off = [c for c in data["check"] if not c.get("matches")]
    if off:
        raise InputError("账户行合计与总计行对不上：" + "；".join(f"{c['field']} 账户合计 {c['rows']} / 总计 {c['total']}" for c in off) + "，不写。")
    day = parse_day(str(data.get("date")))
    config = read_json(args.tables)
    tables = config.get("tables") or {}
    existing = {provider: set(rows) for provider, rows in table_records(args.records).items()}
    blank = [row["账户名称"] for row in data["accounts"] if not str(row.get("账户id") or "").strip()]
    if blank:
        raise InputError("这些账户没有账户id，无法查重：" + "、".join(blank) + "，不写。")
    groups, self_run, unknown, no_table, skipped = {}, [], [], {}, 0
    for row in data["accounts"]:
        provider = provider_of(row["账户名称"])
        if provider == "自营":
            self_run.append(row["账户名称"])
        elif provider is None:
            unknown.append(row["账户名称"])
        elif provider not in tables:
            no_table.setdefault(provider, []).append(row["账户名称"])
        elif (day, row["账户id"]) in existing.get(provider, set()):
            skipped += 1
        else:
            groups.setdefault(provider, []).append([
                row["账户id"], row["账户名称"], data.get("channel") or "抖音", f"{day.isoformat()} 00:00:00",
                row["消耗"], row["总GMV"], row["有效GMV"], row["退款率"], row["退款金额"],
            ])
    os.makedirs(args.out, exist_ok=True)
    writes = []
    for provider, rows in sorted(groups.items()):
        for n in range(0, len(rows), BATCH):
            path = os.path.join(args.out, f"batch-{provider}-{n // BATCH}.json")
            with open(path, "w", encoding="utf-8") as f:
                json.dump({"fields": FIELDS, "rows": rows[n:n + BATCH]}, f, ensure_ascii=False)
            writes.append({"provider": provider, "table_id": tables[provider], "file": path, "count": len(rows[n:n + BATCH]),
                           "accounts": [r[0] for r in rows[n:n + BATCH]]})
    result = {"date": day.isoformat(), "accounts": len(data["accounts"]), "writes": writes, "already_written": skipped,
              "self_operated": self_run, "unknown_provider": unknown, "no_table": no_table}
    with open(os.path.join(args.out, "plan.json"), "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=1)
    print(json.dumps(result, ensure_ascii=False, indent=1))
    return 0


def verify(args):
    planned = read_json(args.plan)
    day = parse_day(planned["date"])
    tables = table_records(args.records)
    problems = []
    for write in planned["writes"]:
        rows = tables.get(write["provider"], [])
        for account in write["accounts"]:
            count = rows.count((day, account))
            if count != 1:
                problems.append(f"{write['provider']} 表 {day} 账户 {account}：{'没有写进去' if count == 0 else f'有 {count} 条，重复了'}")
    if problems:
        print("写后核对不一致：\n" + "\n".join(problems))
        return 1
    total = sum(w["count"] for w in planned["writes"])
    print(f"写后核对一致：{day} 共 {total} 条，各服务商表里各有且只有一条。")
    return 0


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="云台每日补采计算")
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("gap")
    p.add_argument("--records", required=True)
    p.add_argument("--to", required=True)
    p.add_argument("--checkpoint")
    p = sub.add_parser("plan")
    p.add_argument("--accounts", required=True)
    p.add_argument("--tables", required=True)
    p.add_argument("--records", required=True)
    p.add_argument("--out", required=True)
    p = sub.add_parser("verify")
    p.add_argument("--plan", required=True)
    p.add_argument("--records", required=True)
    args = parser.parse_args()
    try:
        sys.exit({"gap": gap, "plan": plan, "verify": verify}[args.command](args))
    except InputError as e:
        print(f"错误: {e}")
        sys.exit(2)


if __name__ == "__main__":
    main()
