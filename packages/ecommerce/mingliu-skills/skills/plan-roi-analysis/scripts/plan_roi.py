#!/usr/bin/env python3
"""云台计划级 ROI 分析：按消耗阈值与有效 ROI 分档，生成并自检飞书卡片（card 2.0）。

用法:
    python3 plan_roi.py --plans <计划明细.json> --out <目录> [--spend-min 700] [--hi 1.5] [--mid 1.2]

<计划明细.json> 是 yuntai-details 的 yuntai-plans.mjs 输出。
在 <目录> 下写 classified.json（三档清单与账户汇总）和 card.json（一行；单引号和弯引号都写成 JSON 转义，
bash 和 PowerShell 都可直接放进 `--content '<card.json 的内容>'`），并打印摘要。卡片超过飞书大小上限时逐步减少高 ROI 表的行数，并在卡片里注明。
退出码：0 = 已生成；2 = 输入有误或卡片自检不通过。
"""
import argparse
import datetime
import json
import os
import sys

MAX_CARD_BYTES = 28000
TEMPLATES = {"blue", "wathet", "turquoise", "green", "yellow", "orange", "red", "carmine", "violet", "purple", "indigo", "grey", "default"}


class InputError(Exception):
    """输入文件不对或卡片不合格。"""


def read_json(path):
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


def classify(plans, spend_min, hi, mid):
    """消耗超过阈值的计划按有效 ROI 分三档，另算整体有效 ROI 与账户汇总。"""
    over = [p for p in plans if p["消耗"] > spend_min]
    high = sorted((p for p in over if p["有效ROI"] >= hi), key=lambda p: -p["有效ROI"])
    fair = sorted((p for p in over if mid <= p["有效ROI"] < hi), key=lambda p: -p["有效ROI"])
    low = sorted((p for p in over if p["有效ROI"] < mid), key=lambda p: p["有效ROI"])
    spend = sum(p["消耗"] for p in plans)
    gmv = sum(p["有效GMV"] for p in plans)
    accounts = {}
    for p in over:
        a = accounts.setdefault(p["账户名称"], {"账户": p["账户名称"], "高ROI条数": 0, "消耗合计": 0.0, "有效GMV合计": 0.0})
        a["高ROI条数"] += 1 if p["有效ROI"] >= hi else 0
        a["消耗合计"] += p["消耗"]
        a["有效GMV合计"] += p["有效GMV"]
    by_account = sorted(accounts.values(), key=lambda a: -a["消耗合计"])
    for a in by_account:
        a["消耗合计"] = round(a["消耗合计"], 2)
        a["有效GMV合计"] = round(a["有效GMV合计"], 2)
        a["有效ROI"] = round(a["有效GMV合计"] / a["消耗合计"], 2) if a["消耗合计"] else 0
    return {
        "spend_min": spend_min, "hi": hi, "mid": mid, "plans": len(plans), "over": len(over),
        "total_spend": round(spend, 2), "total_valid_gmv": round(gmv, 2), "overall_roi": round(gmv / spend, 2) if spend else None,
        "high": high, "fair": fair, "low": low, "accounts": by_account,
    }


def money(value):
    return f"{value:,.2f}"


def table(header, rows):
    lines = ["| " + " | ".join(header) + " |", "|" + "|".join("---" for _ in header) + "|"]
    lines += ["| " + " | ".join(str(cell).replace("|", "/") for cell in row) + " |" for row in rows]
    return "\n".join(lines)


def build_card(c, start, end, high_rows):
    """卡片：总览摘要 → 一、高 ROI 计划 → 优先加码 → 二、建议关停 → 三、账户维度。"""
    days = (datetime.date.fromisoformat(end) - datetime.date.fromisoformat(start)).days + 1
    lines = [
        f"**统计窗口**：{start} ~ {end}（{days} 天，抖音）",
        f"**消耗 > {c['spend_min']:g} 元的计划**：{c['over']} 条（窗口内共 {c['plans']} 条）",
        f"**分档**：高 ROI（≥{c['hi']:g}）{len(c['high'])} 条 · 达标（{c['mid']:g}~{c['hi']:g}）{len(c['fair'])} 条 · 低 ROI（<{c['mid']:g}）{len(c['low'])} 条",
        f"**整体有效 ROI**：{c['overall_roi'] if c['overall_roi'] is not None else '无消耗'}（总消耗 {money(c['total_spend'])} / 有效GMV {money(c['total_valid_gmv'])}）",
    ]
    shown = c["high"][:high_rows]
    high = table(["#", "计划名", "计划ID", "账户", "消耗", "有效GMV", "ROI"],
                 [[i, p["计划名称"], p["计划ID"], p["账户名称"], money(p["消耗"]), money(p["有效GMV"]), f"{p['有效ROI']:.2f}"] for i, p in enumerate(shown, 1)])
    if len(c["high"]) > len(shown):
        high += f"\n\n另有 {len(c['high']) - len(shown)} 条高 ROI 计划未列出（卡片篇幅所限）。"
    boost = sorted(c["high"], key=lambda p: -p["消耗"])[:5]
    boost_text = "\n".join(f"- {p['计划名称']}（{p['计划ID']}）· 消耗 {money(p['消耗'])} · ROI {p['有效ROI']:.2f}" for p in boost) or "- 无高 ROI 计划"
    stop = table(["计划名", "计划ID", "账户", "消耗", "有效GMV", "ROI"],
                 [[p["计划名称"], p["计划ID"], p["账户名称"], money(p["消耗"]), money(p["有效GMV"]), f"{p['有效ROI']:.2f}"] for p in c["low"][:10]])
    acc = table(["账户", "高ROI条数", "消耗合计", "有效GMV合计"], [[a["账户"], a["高ROI条数"], money(a["消耗合计"]), money(a["有效GMV合计"])] for a in c["accounts"]])
    good = [a for a in c["accounts"] if a["高ROI条数"] > 0]
    best = max(good, key=lambda a: a["有效ROI"], default=None)
    weak = [a["账户"] for a in c["accounts"] if a["有效ROI"] < c["mid"]]
    notes = []
    if best:
        notes.append(f"头部高效账户：{best['账户']}（有效 ROI {best['有效ROI']:.2f}，高 ROI 计划 {best['高ROI条数']} 条）")
    notes.append("不达标账户（有效 ROI 低于 {:g}）：{}".format(c["mid"], "、".join(weak) if weak else "无"))
    sections = [
        "\n".join(lines),
        f"**一、高 ROI 计划（ROI ≥ {c['hi']:g}，按 ROI 从高到低）**\n\n" + (high if shown else "无"),
        "**优先加码**（高 ROI 计划中消耗最高的 5 条）\n" + boost_text,
        f"**二、建议关停（ROI < {c['mid']:g}，最低 10 条）**\n\n" + (stop if c["low"] else "无"),
        f"**三、账户维度（消耗 > {c['spend_min']:g} 元的计划）**\n\n" + (acc if c["accounts"] else "无") + "\n\n" + "\n".join(f"- {n}" for n in notes),
    ]
    return {
        "schema": "2.0",
        "header": {"title": {"tag": "plain_text", "content": f"站外投流 · {days}天高ROI计划清单（{start}–{end}）"}, "template": "blue"},
        "body": {"elements": [{"tag": "markdown", "content": s} for s in sections]},
    }


#: 会结束 bash / PowerShell 单引号字符串的字符，在卡片 JSON 里写成转义。
QUOTES = {"'": "\\u0027", "\u2018": "\\u2018", "\u2019": "\\u2019", "\u201a": "\\u201a", "\u201b": "\\u201b"}


def card_text(card):
    """卡片的一行 JSON，引号字符写成转义，可放进单引号参数。"""
    text = json.dumps(card, ensure_ascii=False, separators=(",", ":"))
    for quote, escaped in QUOTES.items():
        text = text.replace(quote, escaped)
    return text


def check_card(card):
    """卡片自检：card 2.0 的结构、标题、元素和大小。"""
    problems = []
    if card.get("schema") != "2.0":
        problems.append("schema 不是 2.0")
    header = card.get("header") or {}
    if not (header.get("title") or {}).get("content"):
        problems.append("没有标题")
    if header.get("template") not in TEMPLATES:
        problems.append(f"标题颜色 {header.get('template')} 不可用")
    elements = (card.get("body") or {}).get("elements") or []
    if not elements:
        problems.append("正文没有元素")
    for i, e in enumerate(elements):
        if e.get("tag") != "markdown" or not isinstance(e.get("content"), str) or not e["content"].strip():
            problems.append(f"第 {i + 1} 个元素不是有内容的 markdown")
    size = len(card_text(card).encode("utf-8"))
    if size > MAX_CARD_BYTES:
        problems.append(f"卡片 {size} 字节，超过 {MAX_CARD_BYTES}")
    return problems


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description="云台计划 ROI 分析")
    ap.add_argument("--plans", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--spend-min", type=float, default=700.0)
    ap.add_argument("--hi", type=float, default=1.5)
    ap.add_argument("--mid", type=float, default=1.2)
    args = ap.parse_args()
    try:
        if not args.mid < args.hi:
            raise InputError(f"--mid {args.mid:g} 要小于 --hi {args.hi:g}。")
        printed = read_json(args.plans)
        data = printed.get("data", printed) if isinstance(printed, dict) else None
        if not isinstance(data, dict) or not isinstance(data.get("plans"), list) or not all(
                isinstance(data.get(k), str) and len(data[k]) == 10 for k in ("from", "to")):
            raise InputError(f"{args.plans} 不是 yuntai-plans.mjs 的输出。")
        c = classify(data["plans"], args.spend_min, args.hi, args.mid)
        rows = len(c["high"])
        card = build_card(c, data["from"], data["to"], rows)
        while check_card(card) and rows > 5:
            rows = max(5, rows - 5)
            card = build_card(c, data["from"], data["to"], rows)
        problems = check_card(card)
        if problems:
            raise InputError("卡片自检不通过：" + "；".join(problems))
        os.makedirs(args.out, exist_ok=True)
        with open(os.path.join(args.out, "classified.json"), "w", encoding="utf-8") as f:
            json.dump({**c, "from": data["from"], "to": data["to"]}, f, ensure_ascii=False, indent=1)
        text = card_text(card)
        with open(os.path.join(args.out, "card.json"), "w", encoding="utf-8") as f:
            f.write(text)
    except InputError as e:
        print(f"错误: {e}")
        sys.exit(2)
    print(f"窗口 {data['from']} ~ {data['to']}：计划 {c['plans']} 条，消耗 > {args.spend_min:g} 的 {c['over']} 条；"
          f"高 ROI {len(c['high'])}、达标 {len(c['fair'])}、低 ROI {len(c['low'])}；整体有效 ROI {c['overall_roi']}。")
    print(f"卡片自检通过（高 ROI 表列出 {min(rows, len(c['high']))} 条），已写 {os.path.join(args.out, 'card.json')}。")


if __name__ == "__main__":
    main()
