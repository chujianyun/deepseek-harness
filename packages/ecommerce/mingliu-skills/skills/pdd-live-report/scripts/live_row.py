#!/usr/bin/env python3
"""拼多多直播日数据追加到「直播数据每日」表：定位末行、生成新行、写后核对。

用法:
    python3 live_row.py pending --cells <cells.json> --to <YYYY-MM-DD>
    python3 live_row.py plan    --cells <cells.json> --figures <采集.json> --out <目录> [--rows <表的行数>]
    python3 live_row.py verify  --plan <plan.json> --before <cells.json> --after <cells.json>

<cells.json> 是 `lark-cli sheets +cells-get --range A1:I<末行> --include value,formula` 的输出；
<采集.json> 是 pdd-live-figures 脚本输出的那一行 JSON。

pending: 打印表中最后一个日期之后、到 --to 为止还没写的日期（最多 7 天，早的在前）；表里一个日期都没有时只给 --to。
plan: 在 --out 下写 plan.json 和 row.json（+cells-set --cells 用），追加到 A 列最后一个有内容的行的下一行：
    A 斜杠日期（yyyy/m/d）、B 直播GMV、C 直播支付订单、D 客单价公式 =B/C、E 直播支付转化率（0.00%）、
    F 人均观看时长、G 千次进人成交、H 直播间涨粉数、I 每日观看量。
    这一天表里已经有了 → 打印「已存在」并退出 0，不生成 row.json；早于表中最后日期、A 列最后一行不是日期
    （如「合计」）、或新行超出 --rows（表格行数已满）→ 退出 2，不写。
verify: 回读核对新行，并确认 A~I 列其他行没有变；一致退出 0，否则 1。A 列回读为文字（不是日期序列号）时照样
    通过，但打印提醒，请人工确认它是日期格式。
其他退出码：2 = 输入有误。
"""
import argparse
import datetime
import json
import os
import re
import sys

COLUMNS = "ABCDEFGHI"
EXCEL_EPOCH = datetime.date(1899, 12, 30)


class InputError(Exception):
    """输入文件或表格结构不对。"""


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


def cells_of(data):
    """+cells-get 的输出 → {(行号, 列字母): {"value", "formula"}}。"""
    ranges = (data.get("data") or {}).get("ranges") if isinstance(data, dict) else None
    if not ranges:
        raise InputError("cells 文件里没有 data.ranges，请用 lark-cli sheets +cells-get --include value,formula 读取。")
    cells = {}
    for part in ranges:
        for i, row in enumerate(part.get("cells") or []):
            for j, cell in enumerate(row):
                cell = cell if isinstance(cell, dict) else {"value": cell}
                cells[(part["row_indices"][i], part["col_indices"][j])] = {"value": cell.get("value"), "formula": cell.get("formula") or ""}
    return cells


def date_of(value):
    """A 列单元格的日期：日期序列号、2026/10/8 或 2026-10-08；其他内容为 None。"""
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        return EXCEL_EPOCH + datetime.timedelta(days=int(value)) if 30000 < value < 80000 else None
    match = re.fullmatch(r"(\d{4})[/-](\d{1,2})[/-](\d{1,2})", str(value).strip())
    if not match:
        return None
    try:
        return datetime.date(*map(int, match.groups()))
    except ValueError:
        return None


def column_a(cells):
    """A 列：(最后一个有内容的行号, 它的内容, 各行日期列表)。"""
    rows = [row for (row, col), cell in cells.items() if col == "A" and str(cell["value"] or "").strip()]
    dates = [d for (row, col), cell in cells.items() if col == "A" for d in [date_of(cell["value"])] if d]
    last = max(rows) if rows else 0
    return last, (cells.get((last, "A")) or {}).get("value"), dates


def number_of(value):
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    try:
        return float(str(value).replace(",", "").replace("%", "").strip())
    except ValueError:
        return None


def slash(day):
    return f"{day.year}/{day.month}/{day.day}"


def figures_of(path):
    printed = read_json(path)
    data = printed.get("data", printed) if isinstance(printed, dict) else None
    platforms = data.get("platforms") if isinstance(data, dict) else None
    live = next((p for p in platforms or [] if p.get("platform") == "拼多多直播"), None)
    if live is None:
        raise InputError(f"{path} 不是 pdd-live-figures 的输出（没有「拼多多直播」）。")
    metrics = live.get("metrics") or {}
    names = ["直播GMV", "直播支付订单", "直播支付转化率", "人均观看时长", "累计观看量", "千次进人成交", "直播间涨粉数"]
    missing = [name for name in names if not isinstance(metrics.get(name), (int, float))]
    if missing:
        raise InputError(f"采集结果缺少 {'、'.join(missing)}，不写表。")
    day = date_of(live.get("date"))
    if day is None:
        raise InputError(f"采集结果的日期 {live.get('date')} 不是 YYYY-MM-DD。")
    return day, metrics


def pending(args):
    _, _, dates = column_a(cells_of(read_json(args.cells)))
    to = date_of(args.to)
    if to is None:
        raise InputError(f"--to {args.to} 不是有效日期。")
    if not dates:
        print(json.dumps([args.to]))
        return 0
    first = max(max(dates) + datetime.timedelta(days=1), to - datetime.timedelta(days=6))
    days = [(first + datetime.timedelta(days=n)).isoformat() for n in range((to - first).days + 1)]
    print(json.dumps(days))
    return 0


def plan(args):
    cells = cells_of(read_json(args.cells))
    day, m = figures_of(args.figures)
    last_row, last_value, dates = column_a(cells)
    if day in dates:
        print(json.dumps({"status": "exists", "date": day.isoformat(), "message": f"表里已经有 {slash(day)} 这一行，不再追加。"}, ensure_ascii=False))
        return 0
    if dates and day < max(dates):
        raise InputError(f"{day} 早于表中最后的日期 {max(dates)}，不插到中间，请人工处理。")
    if dates and date_of(last_value) is None:
        raise InputError(f"A 列最后一行（第 {last_row} 行「{last_value}」）不是日期，不知道新行该接在哪，请人工处理。")
    row = last_row + 1
    if args.rows is not None and row > args.rows:
        raise InputError(f"表格只有 {args.rows} 行，新行要写到第 {row} 行：请先在表末尾插入空行。")
    values = [
        {"value": slash(day), "cell_styles": {"number_format": "yyyy/m/d"}},
        {"value": round(m["直播GMV"], 2), "cell_styles": {"number_format": "0.00"}},
        {"value": int(m["直播支付订单"])},
        {"formula": f"=B{row}/C{row}", "cell_styles": {"number_format": "0.00"}},
        {"value": m["直播支付转化率"], "cell_styles": {"number_format": "0.00%"}},
        {"value": m["人均观看时长"]},
        {"value": round(m["千次进人成交"], 2)},
        {"value": int(m["直播间涨粉数"])},
        {"value": int(m["累计观看量"])},
    ]
    os.makedirs(args.out, exist_ok=True)
    row_file = os.path.join(args.out, "row.json")
    with open(row_file, "w", encoding="utf-8") as f:
        json.dump([values], f, ensure_ascii=False)
    result = {"status": "append", "date": day.isoformat(), "row": row, "range": f"A{row}:I{row}", "file": row_file, "cells": values}
    with open(os.path.join(args.out, "plan.json"), "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=1)
    print(json.dumps(result, ensure_ascii=False, indent=1))
    return 0


def same(got, want):
    """回读值与写入值是否一致：写入的数原样读回；E 列回读成「0.61%」时按两位百分数比。"""
    if isinstance(got, str) and got.strip().endswith("%"):
        value = number_of(got)
        return value is not None and abs(value / 100 - want) <= 0.00005
    value = number_of(got)
    return value is not None and abs(value - want) <= 1e-6


def verify(args):
    planned = read_json(args.plan)
    before, after = cells_of(read_json(args.before)), cells_of(read_json(args.after))
    row = planned["row"]
    problems, notes = [], []
    for col, want in zip(COLUMNS, planned["cells"]):
        cell = after.get((row, col)) or {"value": None, "formula": ""}
        if col == "A":
            if date_of(cell["value"]) != date_of(planned["date"]):
                problems.append(f"A{row} 应为日期 {want['value']}，回读为 {cell['value']}")
            elif isinstance(cell["value"], str):
                notes.append(f"A{row} 回读为文字「{cell['value']}」，请确认它是日期格式而不是文本。")
        elif "formula" in want:
            if cell["formula"].replace(" ", "").upper() != want["formula"].upper():
                problems.append(f"{col}{row} 应为公式 {want['formula']}，回读为 {cell['formula'] or cell['value']}")
        elif not same(cell["value"], want["value"]):
            problems.append(f"{col}{row} 应为 {want['value']}，回读为 {cell['value']}")
    for (r, col), cell in before.items():
        if r != row and col in COLUMNS and cell != after.get((r, col), {"value": None, "formula": ""}):
            problems.append(f"{col}{r} 不该被改动：写前 {cell['value']}，写后 {(after.get((r, col)) or {}).get('value')}")
    if problems:
        print("回读不一致：\n" + "\n".join(problems))
        return 1
    print(f"回读一致：第 {row} 行 A~I 与采集值相符，D 为公式；其他行未改动。")
    for note in notes:
        print(f"提醒：{note}")
    return 0


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="拼多多直播日数据追加")
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("pending")
    p.add_argument("--cells", required=True)
    p.add_argument("--to", required=True)
    p = sub.add_parser("plan")
    p.add_argument("--cells", required=True)
    p.add_argument("--figures", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--rows", type=int)
    p = sub.add_parser("verify")
    p.add_argument("--plan", required=True)
    p.add_argument("--before", required=True)
    p.add_argument("--after", required=True)
    args = parser.parse_args()
    if getattr(args, "to", None) and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", args.to):
        print(f"错误: --to 要写成 YYYY-MM-DD，收到 {args.to}")
        sys.exit(2)
    try:
        sys.exit({"pending": pending, "plan": plan, "verify": verify}[args.command](args))
    except InputError as e:
        print(f"错误: {e}")
        sys.exit(2)


if __name__ == "__main__":
    main()
