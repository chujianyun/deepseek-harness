#!/usr/bin/env python3
"""部门巡检读数：从表格原样读出某天每一行的负责人、目标、实际，写成 inspection_card.py 的输入。

用法:
    python3 inspection_read.py tmall --cells <天猫表.json> --date <YYYY-MM-DD> --out <tmall.json>
    python3 inspection_read.py pdd  --target-cells <拼多多目标表.json> --actuals <拼多多实际.json> --date <YYYY-MM-DD> --out <pdd.json>

<天猫表.json> / <拼多多目标表.json> 是 `lark-cli sheets +cells-get --include value,formula --output-path` 写的文件（重定向的整段输出也可）；
<拼多多实际.json> 是 `lark-cli base +record-list --format json` 的输出（实际多维表，元）。
天猫：按表头「实际完成（M月D日）」定实际列，紧挨的左一列为目标列（表头须是同一天）；A 列指标、B 列负责人；目标写成百分数的行标 percent。
拼多多：目标表按表头「M月D日」定目标列（万元，保留 2 位）；实际表取「日期」为这一天的那条记录，元 ÷ 10000；
店铺名先找同名字段，没有再找去掉开头「名流」的字段；找不到或对上多个就报错，不猜。
实际为空写 null（待更新，不按 0）。花费 / 费用类为辅助项，费比 / 排名为反向。
退出码：0 = 已写；2 = 表格对不上，报告原因，不出卡片。
"""
import argparse
import datetime
import json
import os
import re
import sys

from inspection_card import InputError, read_json

DATE = re.compile(r"(\d{1,2})月(\d{1,2})日")
ACTUAL = re.compile(r"^实际完成[（(](\d{1,2})月(\d{1,2})日[）)]$")
#: 拼多多永久排除的店铺。
EXCLUDED = {"名流器械保健旗舰店"}
#: 实际表里不是店铺的字段。
NOT_STORES = {"日期", "日期1", "目标", "合计"}


def clean(value):
    return re.sub(r"\s+", "", str(value)) if value is not None else ""


def number_of(value):
    """单元格的数；「66%」读作 0.66；空、文字为 None。"""
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = clean(value).replace(",", "")
    percent = text.endswith("%")
    try:
        return round(float(text[:-1]) / 100, 8) if percent else float(text)
    except ValueError:
        return None


def direction_of(name):
    if "花费" in name or "费用" in name:
        return "auxiliary"
    if "费比" in name or "排名" in name:
        return "reverse"
    return "normal"


def grid(data, path):
    """+cells-get 的输出（重定向的整段输出，或 --output-path 写的 data 部分）→ {(行号, 列字母): 值}；被截断的读数拒绝。"""
    payload = data.get("data", data) if isinstance(data, dict) else None
    ranges = payload.get("ranges") if isinstance(payload, dict) else None
    if not ranges:
        raise InputError(f"{path} 里没有 ranges，请用 lark-cli sheets +cells-get --include value,formula --output-path 读取。")
    if payload.get("has_more"):
        raise InputError(f"{path} 没读全（has_more），请缩小 --range 后重读。")
    cells = {}
    for part in ranges:
        if part.get("truncated"):
            raise InputError(f"{path} 读数被截断，没读全，请缩小 --range 后重读。")
        for i, row in enumerate(part.get("cells") or []):
            for j, cell in enumerate(row):
                cell = cell if isinstance(cell, dict) else {"value": cell}
                cells[(part["row_indices"][i], part["col_indices"][j])] = cell.get("value")
    return cells


def col_index(col):
    n = 0
    for ch in col:
        n = n * 26 + ord(ch) - 64
    return n


def header_columns(cells, date, pattern):
    """第 1 行里表头匹配这一天的列。"""
    found = []
    for (row, col), value in cells.items():
        match = pattern.search(clean(value)) if row == 1 else None
        if match and (int(match.group(1)), int(match.group(2))) == (date.month, date.day):
            found.append(col)
    return sorted(found, key=col_index)


def rows_of(cells):
    """第 2 行起 A 列有名称、B 列有负责人的行：(行号, 名称, 负责人)。"""
    rows = sorted({row for row, _ in cells if row > 1})
    return [(row, clean(cells.get((row, "A"))), clean(cells.get((row, "B")))) for row in rows
            if clean(cells.get((row, "A"))) and clean(cells.get((row, "B")))]


def read_tmall(cells, date):
    day = f"{date.month}月{date.day}日"
    actual_cols = [c for c in header_columns(cells, date, DATE) if ACTUAL.match(clean(cells.get((1, c))))]
    if len(actual_cols) != 1:
        raise InputError(f"表头里「实际完成（{day}）」{'没有' if not actual_cols else '不止一列'}，这张表可能不是这个月的。")
    actual_col = actual_cols[0]
    index = col_index(actual_col) - 1
    target_col = next((c for (r, c) in cells if r == 1 and col_index(c) == index), None)
    header = clean(cells.get((1, target_col))) if target_col else ""
    match = DATE.search(header)
    if not match or (int(match.group(1)), int(match.group(2))) != (date.month, date.day) or header.startswith("实际"):
        raise InputError(f"「实际完成（{day}）」左边一列的表头是「{header}」，不是这一天的目标列。")
    items = []
    for row, name, owner in rows_of(cells):
        item = {"owner": owner, "name": name, "target": number_of(cells.get((row, target_col))),
                "actual": number_of(cells.get((row, actual_col))), "direction": direction_of(name), "source": f"{target_col}{row}/{actual_col}{row}"}
        if clean(cells.get((row, target_col))).endswith("%"):
            item["percent"] = True
        items.append(item)
    if not items:
        raise InputError("A 列没有同时写了指标和负责人的行。")
    return items


def record_date(value):
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return datetime.datetime.fromtimestamp(value / 1000, datetime.timezone(datetime.timedelta(hours=8))).date().isoformat()
    return str(value or "")[:10]


def read_pdd(cells, actuals, date):
    day = f"{date.month}月{date.day}日"
    target_cols = header_columns(cells, date, DATE)
    if len(target_cols) != 1:
        raise InputError(f"目标表表头里「{day}」{'没有' if not target_cols else '不止一列'}，这张表可能不是这个月的。")
    target_col = target_cols[0]
    data = actuals.get("data") if isinstance(actuals, dict) else None
    if not isinstance(data, dict) or not isinstance(data.get("fields"), list) or not isinstance(data.get("data"), list):
        raise InputError("实际表不是 lark-cli base +record-list --format json 的输出。")
    if data.get("has_more"):
        raise InputError("实际表没读全（has_more），请加大 --limit 重读。")
    fields = data["fields"]
    if "日期" not in fields:
        raise InputError("实际表没有「日期」字段。")
    records = [dict(zip(fields, row)) for row in data["data"]]
    found = [r for r in records if record_date(r.get("日期")) == date.isoformat()]
    if len(found) != 1:
        raise InputError(f"实际表里日期为 {date.isoformat()} 的记录{'没有' if not found else '不止一条'}。")
    record = found[0]
    stores = [f for f in fields if f not in NOT_STORES]
    items, used = [], set()
    for row, name, owner in rows_of(cells):
        if name in EXCLUDED or name == "合计":
            continue
        matches = [f for f in stores if f == name] or [f for f in stores if name.startswith("名流") and f == name[2:]]
        if len(matches) != 1:
            raise InputError(f"目标表的「{name}」在实际表里{'找不到对应字段' if not matches else '对上了多个字段：' + '、'.join(matches)}。")
        field = matches[0]
        used.add(field)
        yuan = number_of(record.get(field))
        target = number_of(cells.get((row, target_col)))
        items.append({"owner": owner, "name": name, "target": round(target, 2) if target is not None else None,
                      "actual": round(yuan / 10000, 4) if yuan is not None else None, "direction": "normal",
                      "source": f"{target_col}{row}/{field}"})
    if not items:
        raise InputError("目标表 A 列没有同时写了店铺和负责人的行。")
    return items, [f for f in stores if f not in used and f not in EXCLUDED and f"名流{f}" not in EXCLUDED]


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description="部门巡检读数")
    sub = ap.add_subparsers(dest="platform", required=True)
    t = sub.add_parser("tmall")
    t.add_argument("--cells", required=True)
    p = sub.add_parser("pdd")
    p.add_argument("--target-cells", required=True)
    p.add_argument("--actuals", required=True)
    for s in (t, p):
        s.add_argument("--date", required=True)
        s.add_argument("--out", required=True)
    args = ap.parse_args()
    unread = []
    try:
        try:
            date = datetime.date.fromisoformat(args.date)
        except ValueError:
            raise InputError("--date 要写成 YYYY-MM-DD。")
        if args.platform == "tmall":
            items = read_tmall(grid(read_json(args.cells), args.cells), date)
        else:
            items, unread = read_pdd(grid(read_json(args.target_cells), args.target_cells), read_json(args.actuals), date)
        platform = "天猫一店" if args.platform == "tmall" else "拼多多"
        os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump({"platform": platform, "date": date.isoformat(), "items": items}, f, ensure_ascii=False, indent=1)
    except InputError as e:
        print(f"错误: {e}")
        sys.exit(2)
    print(f"{platform} {date.isoformat()}：读到 {len(items)} 行，已写 {args.out}。")
    for i in items:
        actual = "待更新" if i["actual"] is None else f"{i['actual']:g}"
        target = "空" if i["target"] is None else f"{i['target']:g}"
        print(f"- {i['owner']}｜{i['name']}：目标 {target}，实际 {actual}（{i['source']}）")
    if unread:
        print("实际表里有目标表没有的店铺，未纳入：" + "、".join(unread))


if __name__ == "__main__":
    main()
