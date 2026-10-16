#!/usr/bin/env python3
"""天猫日报填报的计算：按 A 列指标名定位行、按表头定位「实际完成」列，把采集到的元值换算成要写的值。

用法:
    python3 daily_report.py plan       --cells <cells.json> --date <YYYY-MM-DD> --figures <采集.json> [--figures …] --out <目录>
    python3 daily_report.py backtest   --cells <cells.json> --date <YYYY-MM-DD> --figures <采集.json> [--figures …]
    python3 daily_report.py candidates --cells <cells.json>
    python3 daily_report.py pending    --cells <cells.json> --from <YYYY-MM-DD> --to <YYYY-MM-DD>
    python3 daily_report.py verify     --plan <plan.json> --before <cells.json> --after <cells.json>

<cells.json> 是 `lark-cli sheets +cells-get --include value,formula` 的输出（整张表的 A1 到最后一列）；
<采集.json> 是 tmall-daily-figures 两个脚本各自输出的那一行 JSON。

plan: 在 --out 下写 plan.json 和每段连续单元格的 cells-<起>-<止>.json（+cells-set --cells 用），并打印计划。
backtest: 不写任何东西，打印回测报告；全部通过退出 0，否则 1。成交类指标采集值偏低且在 3% 以内视为其后退款，判通过并注明。
candidates: 打印可用来回测的日期（店铺gmv、外投成交、自投成交、推广成交的实际完成都有值），最近的在前。
pending: 打印 --from 到 --to 之间、这张表里有「实际完成」列、且映射指标里还有空着的非公式格的日期，早的在前。
plan 只写空着的格；已有值的格（人工填过或改过）不覆盖，列在 skipped 里。
verify: 写后回读核对；写入值一致、其余非公式格未变退出 0，否则 1。
其他退出码：2 = 输入有误（文件读不了、表头或日期列找不到）。
"""
import argparse
import json
import os
import re
import sys

#: 要写的指标 → (类型, 计算方式)；money 换算为万元，ratio 为两数之比。
SOURCES = {
    "店铺gmv": ("money", ["生意参谋.全店支付金额"]),
    "外投花费": ("money", ["健康品牌云台.三方外投消耗", "-健康品牌云台.自投花费"]),
    "外投成交": ("money", ["健康品牌云台.三方外投有效GMV", "-健康品牌云台.自投有效GMV"]),
    "外投投产": ("ratio", ["外投成交", "外投花费"]),
    "自投花费": ("money", ["健康品牌云台.自投花费"]),
    "自投成交": ("money", ["健康品牌云台.自投有效GMV"]),
    "自投投产": ("ratio", ["自投成交", "自投花费"]),
    "推广花费": ("money", ["万相台.关键词推广花费", "万相台.人群推广花费", "万相台.货品全站推花费"]),
    "推广成交": ("money", ["万相台.关键词推广成交", "万相台.人群推广成交", "万相台.货品全站推成交"]),
    "推广投产": ("ratio", ["推广成交", "推广花费"]),
}

#: 回测允许的相对差异；投产随花费与成交判定，不单独判。
TOLERANCE = {"外投成交": 0.02}
DEFAULT_TOLERANCE = 0.01
ROUNDING = 0.005 + 1e-9

#: 成交类指标采集值比表中值低、且在这个比例以内时判通过：回测的日子早于取数日，成交含其后的退款，比人工次日填报时低是正常的。
REFUND_LAG = 0.03
REFUND_METRICS = {"店铺gmv", "外投成交", "自投成交", "推广成交"}

#: 回测日期必须已有人工填报的指标。
BACKTEST_KEYS = ["店铺gmv", "外投成交", "自投成交", "推广成交"]

HEADER = re.compile(r"^实际完成[（(](\d{1,2})月(\d{1,2})日[)）]$")


class InputError(Exception):
    """输入文件或表格结构不对，没法计算。"""


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


def label_of(text):
    """A 列指标名：去掉空白和括号说明。"""
    text = re.sub(r"\s+", "", str(text))
    return re.sub(r"[（(][^）)]*[）)]", "", text)


def number_of(value):
    """单元格的数值；空、文字或不是数的内容为 None。"""
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).replace(",", "").strip()
    try:
        return float(text)
    except ValueError:
        return None


class Sheet:
    """+cells-get 读到的表：按 (行号, 列字母) 存值和公式。"""

    def __init__(self, data):
        ranges = (data.get("data") or {}).get("ranges") if isinstance(data, dict) else None
        if not ranges:
            raise InputError("cells 文件里没有 data.ranges，请用 lark-cli sheets +cells-get --include value,formula 读取。")
        self.cells = {}
        for part in ranges:
            for i, row in enumerate(part.get("cells") or []):
                for j, cell in enumerate(row):
                    cell = cell if isinstance(cell, dict) else {"value": cell}
                    key = (part["row_indices"][i], part["col_indices"][j])
                    self.cells[key] = {"value": cell.get("value"), "formula": cell.get("formula") or ""}
        self.rows = sorted({row for row, _ in self.cells})

    def value(self, row, col):
        return (self.cells.get((row, col)) or {}).get("value")

    def formula(self, row, col):
        return (self.cells.get((row, col)) or {}).get("formula") or ""

    def actual_columns(self):
        """表头里所有「实际完成（M月D日）」列：(月, 日) → 列字母；同一天出现多次记为 None。"""
        found = {}
        for (row, col), cell in self.cells.items():
            if row > 3:
                continue
            match = HEADER.match(re.sub(r"\s+", "", str(cell["value"] or "")))
            if match:
                day = (int(match.group(1)), int(match.group(2)))
                found[day] = None if day in found else col
        return found

    def actual_column(self, date):
        month, day = int(date[5:7]), int(date[8:10])
        found = self.actual_columns()
        if (month, day) not in found:
            raise InputError(f"表头里没有「实际完成（{month}月{day:02d}日）」列：这张表可能不是 {date[:7]} 的日报表。")
        if found[(month, day)] is None:
            raise InputError(f"表头里「实际完成（{month}月{day:02d}日）」不止一列，无法唯一定位。")
        return found[(month, day)]

    def label_rows(self):
        """A 列指标名 → 行号列表（第 1 行是表头，不算）。"""
        rows = {}
        for row in self.rows:
            if row == 1:
                continue
            label = label_of(self.value(row, "A") or "")
            if label:
                rows.setdefault(label, []).append(row)
        return rows


def figures_of(paths):
    """采集文件 → {"平台.指标": 元值或 None}，以及缺失原因 {"平台.指标": 原因} 和日期集合。"""
    values, reasons, dates = {}, {}, set()
    for path in paths:
        printed = read_json(path)
        data = printed.get("data", printed) if isinstance(printed, dict) else None
        if not isinstance(data, dict) or not isinstance(data.get("platforms"), list):
            raise InputError(f"{path} 不是 tmall-daily-figures 的输出（没有 data.platforms）。")
        dates.add(data.get("date"))
        for platform in data["platforms"]:
            name = platform.get("platform")
            for field, value in (platform.get("metrics") or {}).items():
                values[f"{name}.{field}"] = value
            for item in platform.get("missing") or []:
                reasons[f"{name}.{item.get('field')}"] = item.get("reason")
    return values, reasons, dates


def compute(values, reasons):
    """每个指标的元值（投产为比值）；算不出的给原因。"""
    yuan, why = {}, {}
    for metric, (kind, parts) in SOURCES.items():
        if kind == "ratio":
            numerator, denominator = (yuan.get(parts[0]), yuan.get(parts[1]))
            if numerator is None or denominator is None:
                why[metric] = f"{parts[0]}或{parts[1]}没有值"
            elif denominator == 0:
                why[metric] = f"{parts[1]}为 0"
            else:
                yuan[metric] = numerator / denominator
            continue
        total, missing = 0.0, []
        for part in parts:
            key = part.lstrip("-")
            value = values.get(key)
            if value is None:
                missing.append(f"{key}（{reasons.get(key) or '采集结果里没有'}）")
            else:
                total += -value if part.startswith("-") else value
        if missing:
            why[metric] = "缺 " + "；".join(missing)
        else:
            yuan[metric] = total
    return yuan, why


def blank(value):
    return value is None or str(value).strip() == ""


def to_cell(metric, yuan):
    """要写进表的值：金额换算为万元，投产为比值，都保留 2 位。"""
    value = yuan[metric] / 10000 if SOURCES[metric][0] == "money" else yuan[metric]
    return round(value, 2)


def check_date(dates, date):
    if dates != {date}:
        raise InputError(f"采集文件的日期 {sorted(str(d) for d in dates)} 和 --date {date} 不一致。")


def plan(args):
    sheet = Sheet(read_json(args.cells))
    values, reasons, dates = figures_of(args.figures)
    check_date(dates, args.date)
    col = sheet.actual_column(args.date)
    yuan, why = compute(values, reasons)
    rows = sheet.label_rows()
    writes, skipped = [], []
    for metric in SOURCES:
        found = rows.get(metric, [])
        if len(found) != 1:
            skipped.append({"label": metric, "reason": f"A 列指标名无法唯一定位：{metric}（找到 {len(found)} 行）"})
        elif metric in why:
            skipped.append({"label": metric, "reason": why[metric]})
        elif sheet.formula(found[0], col):
            skipped.append({"label": metric, "reason": f"{col}{found[0]} 是公式，已跳过"})
        elif not blank(sheet.value(found[0], col)):
            skipped.append({"label": metric, "reason": f"{col}{found[0]} 已有值 {sheet.value(found[0], col)}，未覆盖"})
        else:
            writes.append({"cell": f"{col}{found[0]}", "row": found[0], "label": metric, "value": to_cell(metric, yuan), "yuan": round(yuan[metric], 4)})
    unmapped = [label for label in rows if label not in SOURCES]
    writes.sort(key=lambda w: w["row"])
    os.makedirs(args.out, exist_ok=True)
    files = []
    for run in runs(writes):
        cells_range = f"{col}{run[0]['row']}:{col}{run[-1]['row']}"
        path = os.path.join(args.out, f"cells-{col}{run[0]['row']}-{col}{run[-1]['row']}.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump([[{"value": w["value"]}] for w in run], f, ensure_ascii=False)
        files.append({"range": cells_range, "file": path})
    result = {"date": args.date, "column": col, "writes": writes, "files": files, "skipped": skipped, "not_written": unmapped}
    with open(os.path.join(args.out, "plan.json"), "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=1)
    print(json.dumps(result, ensure_ascii=False, indent=1))
    return 0


def runs(writes):
    """按行号连续分段，每段一次 +cells-set。"""
    groups = []
    for w in writes:
        if groups and w["row"] == groups[-1][-1]["row"] + 1:
            groups[-1].append(w)
        else:
            groups.append([w])
    return groups


def backtest(args):
    sheet = Sheet(read_json(args.cells))
    values, reasons, dates = figures_of(args.figures)
    check_date(dates, args.date)
    col = sheet.actual_column(args.date)
    yuan, why = compute(values, reasons)
    rows = sheet.label_rows()
    lines, passed = [], True
    for metric in SOURCES:
        found = rows.get(metric, [])
        current = number_of(sheet.value(found[0], col)) if len(found) == 1 else None
        computed = to_cell(metric, yuan) if metric in yuan else None
        if SOURCES[metric][0] == "ratio":
            verdict = "随花费与成交判定"
        elif len(found) != 1:
            verdict, passed = f"不通过：A 列找到 {len(found)} 行", False
        elif computed is None:
            verdict, passed = f"不通过：{why[metric]}", False
        elif current is None:
            verdict = "表中无值，未比较"
            if metric in BACKTEST_KEYS:
                passed = False
                verdict = "不通过：表中无值，这一天不能用来回测"
        else:
            exact = yuan[metric] / 10000
            diff = abs(exact - current) / abs(current) if current else (0 if exact == 0 else 1)
            limit = TOLERANCE.get(metric, DEFAULT_TOLERANCE)
            # 表里的数保留 2 位万元，差在 0.005 万元以内是舍入。
            ok = diff <= limit or abs(exact - current) <= ROUNDING
            refund = not ok and metric in REFUND_METRICS and exact < current and diff <= REFUND_LAG
            passed = passed and (ok or refund)
            if refund:
                verdict = f"通过（采集值低 {diff:.2%}，在 {REFUND_LAG:.0%} 以内：取数晚于填报，成交含其后退款）"
            else:
                verdict = f"{'通过' if ok else '不通过'}（差异 {diff:.2%}，允许 {limit:.0%}）"
        lines.append(f"| {metric} | {fmt(current)} | {fmt(computed)} | {verdict} |")
    print(f"# 天猫日报回测 {args.date}（{col} 列）\n")
    print("| 指标 | 表中现值 | 采集推算值 | 结论 |\n|---|---:|---:|---|")
    print("\n".join(lines))
    print(f"\n结论：{'回测通过' if passed else '回测不通过'}")
    return 0 if passed else 1


def fmt(value):
    return "" if value is None else f"{value:g}"


def candidates(args):
    sheet = Sheet(read_json(args.cells))
    rows = sheet.label_rows()
    keyed = [rows.get(key, []) for key in BACKTEST_KEYS]
    if any(len(found) != 1 for found in keyed):
        raise InputError("A 列找不到唯一的 " + "、".join(BACKTEST_KEYS) + "，无法挑回测日期。")
    days = []
    for (month, day), col in sheet.actual_columns().items():
        if col and all(number_of(sheet.value(found[0], col)) is not None for found in keyed):
            days.append((month, day, col))
    days.sort(reverse=True)
    print(json.dumps([{"month": m, "day": d, "column": c} for m, d, c in days], ensure_ascii=False))
    return 0


def pending(args):
    sheet = Sheet(read_json(args.cells))
    rows = sheet.label_rows()
    targets = [found[0] for metric, found in rows.items() if metric in SOURCES and len(found) == 1]
    year, last_month = int(args.to[:4]), int(args.to[5:7])
    days = []
    for (month, day), col in sheet.actual_columns().items():
        # 跨年时，比 --to 月份大的月是上一年的。
        date = f"{year - 1 if month > last_month else year}-{month:02d}-{day:02d}"
        if col is None or not args.since <= date <= args.to:
            continue
        if any(not sheet.formula(row, col) and blank(sheet.value(row, col)) for row in targets):
            days.append(date)
    print(json.dumps(sorted(days)))
    return 0


def verify(args):
    planned = read_json(args.plan)
    before, after = Sheet(read_json(args.before)), Sheet(read_json(args.after))
    col = planned["column"]
    written = {w["row"]: w for w in planned["writes"]}
    problems = []
    for w in planned["writes"]:
        got = number_of(after.value(w["row"], col))
        if got is None or abs(got - w["value"]) > 0.005:
            problems.append(f"{w['cell']}（{w['label']}）应为 {w['value']}，回读为 {after.value(w['row'], col)}")
    for row in before.rows:
        if row in written or before.formula(row, col):
            continue
        if before.value(row, col) != after.value(row, col):
            problems.append(f"{col}{row} 不该被改动：写前 {before.value(row, col)}，写后 {after.value(row, col)}")
    if problems:
        print("回读不一致：\n" + "\n".join(problems))
        return 1
    print(f"回读一致：{len(written)} 格写入值正确，{col} 列其余非公式格未改动。")
    return 0


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="天猫日报填报计算")
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("plan", "backtest"):
        p = sub.add_parser(name)
        p.add_argument("--cells", required=True)
        p.add_argument("--date", required=True)
        p.add_argument("--figures", required=True, action="append")
        if name == "plan":
            p.add_argument("--out", required=True)
    sub.add_parser("candidates").add_argument("--cells", required=True)
    p = sub.add_parser("pending")
    p.add_argument("--cells", required=True)
    p.add_argument("--from", dest="since", required=True)
    p.add_argument("--to", required=True)
    p = sub.add_parser("verify")
    p.add_argument("--plan", required=True)
    p.add_argument("--before", required=True)
    p.add_argument("--after", required=True)
    args = parser.parse_args()
    for name in ("date", "since", "to"):
        value = getattr(args, name, None)
        if value and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
            print(f"错误: 日期要写成 YYYY-MM-DD，收到 {value}")
            sys.exit(2)
    commands = {"plan": plan, "backtest": backtest, "candidates": candidates, "pending": pending, "verify": verify}
    try:
        sys.exit(commands[args.command](args))
    except InputError as e:
        print(f"错误: {e}")
        sys.exit(2)


if __name__ == "__main__":
    main()
