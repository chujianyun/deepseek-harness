#!/usr/bin/env python3
"""部门巡检卡片：按达成率分级，生成并自检原巡检卡片格式的飞书卡片（card 2.0，蓝色标题）。

用法:
    python3 inspection_card.py --items <指标.json> --out <目录>

<指标.json>：{"platform": "天猫一店" | "拼多多", "date": "YYYY-MM-DD",
              "items": [{"owner": "负责人", "name": "指标或店铺", "target": 1.91, "actual": 1.67,
                         "direction": "normal" | "reverse" | "auxiliary", "note": "原因：…（可省）", "suggestion": "…（可省）",
                         "percent": true（可省，目标与实际按百分数显示）}]}
通常由 inspection_read.py 读表写出。
target / actual 用报告里的单位（万元等），actual 为 null 表示实际待更新（不按 0）；target 为 null 或 0 不判断。
reverse = 越低越好（费比、排名），达成率 = 目标 / 实际；auxiliary = 花费类辅助项，不分级。
在 <目录> 下写 card.json（一行；单引号和弯引号都写成 JSON 转义，可直接放进 `--content '<card.json 的内容>'`），
并打印分级摘要与卡片预览。退出码：0 = 已生成；2 = 输入有误或卡片自检不通过。
"""
import argparse
import datetime
import json
import os
import sys

MAX_CARD_BYTES = 28000
SECTIONS = ("巡检日期", "整体建议", "需优先关注", "轻微偏移观察", "结尾说明")
#: 每个平台的计数单位与达成率小数位，沿用原巡检卡片。
PLATFORMS = {"天猫一店": ("项指标", 2), "拼多多": ("家店铺", 1)}
DIRECTIONS = {"normal", "reverse", "auxiliary"}
ADVICE_LOW = "本日 {n} {unit}达成率低于 90%，建议相关负责人复查货品/投放/流量/转化链路。"
ADVICE_AI = "AI只做数据解读和提醒，不替代负责人判断。"
ENDING = ["请相关负责人回到对应表格补充原因判断、解决动作、预计完成时间。",
          "说明：本提醒用于部门目标巡检，不做个人绩效打分；机器人只发送提醒，不接收回复。"]


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


def is_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def validate(data):
    if not isinstance(data, dict) or data.get("platform") not in PLATFORMS:
        raise InputError("platform 只能是 " + " / ".join(PLATFORMS) + "。")
    try:
        date = datetime.date.fromisoformat(str(data.get("date")))
    except ValueError:
        raise InputError("date 要写成 YYYY-MM-DD。")
    items = data.get("items")
    if not isinstance(items, list) or not items:
        raise InputError("items 不能为空。")
    for i, item in enumerate(items, 1):
        if not isinstance(item, dict) or not all(isinstance(item.get(k), str) and item[k].strip() for k in ("owner", "name")):
            raise InputError(f"第 {i} 项缺少 owner 或 name。")
        if item.get("direction", "normal") not in DIRECTIONS:
            raise InputError(f"第 {i} 项 direction 只能是 normal / reverse / auxiliary。")
        for key in ("target", "actual"):
            if item.get(key) is not None and not is_number(item[key]):
                raise InputError(f"第 {i} 项 {key} 要是数字或 null。")
    return date, items


def classify(items):
    """按达成率分级：<90% 需优先关注，90%~<100% 轻微偏移；空实际待更新，空目标不判断，辅助项不分级。"""
    c = {"focus": [], "mild": [], "ok": [], "pending": [], "unjudged": [], "auxiliary": []}
    for item in items:
        direction = item.get("direction", "normal")
        target, actual = item.get("target"), item.get("actual")
        if direction == "auxiliary":
            c["auxiliary"].append(item)
        elif actual is None:
            c["pending"].append(item)
        elif not target or (direction == "reverse" and not actual):
            c["unjudged"].append(item)
        else:
            rate = (target / actual if direction == "reverse" else actual / target) * 100
            bucket = "focus" if rate < 90 else "mild" if rate < 100 else "ok"
            c[bucket].append({**item, "rate": rate})
    return c


def grouped(rows, line):
    """按负责人分组（顺序同输入），每组一行加粗负责人，下面逐项列出；组间空一行，否则飞书把下一位负责人并进上一条列表项。"""
    owners = {}
    for row in rows:
        owners.setdefault(row["owner"], []).append(row)
    return "\n\n".join(f"**{owner}**\n" + "\n".join(f"- {line(r)}" for r in group) for owner, group in owners.items())


def build_card(platform, date, c):
    """卡片：蓝色标题（平台 + 巡检日期）→ 巡检日期 / 整体建议 / 需优先关注 / 轻微偏移观察 / 结尾说明，节间分隔线。"""
    unit, digits = PLATFORMS[platform]
    day = f"{date.month}月{date.day}日"
    pct = lambda r: f"{r['rate']:.{digits}f}%"

    def focus_line(r):
        shown = (lambda v: f"{v * 100:.2f}%") if r.get("percent") else (lambda v: f"{v:.2f}")
        text = f"{r['name']}：目标 {shown(r['target'])}，实际 {shown(r['actual'])}，达成率 {pct(r)}，暂无环比数据。"
        if r.get("note"):
            text += r["note"].strip().rstrip("。") + "。"
        if r.get("suggestion"):
            text += f"建议：{r['suggestion'].strip()}"
        return text

    advice = []
    if c["focus"]:
        advice.append(ADVICE_LOW.format(n=len(c["focus"]), unit=unit))
    if c["pending"]:
        names = "、".join(r["name"] for r in c["pending"])
        advice.append(f"{len(c['pending'])} 项实际待更新（{names}），建议补齐后复核。")
    if c["unjudged"]:
        advice.append(f"{len(c['unjudged'])} 项目标为空，不判断（{'、'.join(r['name'] for r in c['unjudged'])}）。")
    if c["auxiliary"]:
        names = "、".join(r["name"] for r in c["auxiliary"])
        advice.append(f"花费类（{names}）为投放辅助项，不计入偏移统计与达成率判断，仅作参考。")
    advice.append(ADVICE_AI)
    bodies = [
        day,
        "\n".join(f"- {a}" for a in advice),
        grouped(c["focus"], focus_line) if c["focus"] else "本日无达成率低于 90% 的项。",
        grouped(c["mild"], lambda r: f"{r['name']}：{pct(r)}") if c["mild"] else "本日无落在 90%–100% 区间的项。",
        "\n".join(ENDING),
    ]
    elements = []
    for name, body in zip(SECTIONS, bodies):
        if elements:
            elements.append({"tag": "hr"})
        elements.append({"tag": "markdown", "content": f"**{name}**\n{body}"})
    low = "、".join(f"{r['name']}{pct(r)}" for r in c["focus"])
    summary = f"{platform}{day}巡检：" + (f"{low}低于90%" if low else "无低于90%的项")
    return {
        "schema": "2.0",
        "config": {"summary": {"content": summary}},
        "header": {"title": {"tag": "plain_text", "content": f"【部门群巡检提醒｜{platform}】"},
                   "subtitle": {"tag": "plain_text", "content": f"巡检日期：{day}"}, "template": "blue"},
        "body": {"elements": elements},
    }


#: 会结束 bash / PowerShell 单引号字符串的字符，在卡片 JSON 里写成转义。
QUOTES = {"'": "\\u0027", "‘": "\\u2018", "’": "\\u2019", "‚": "\\u201a", "‛": "\\u201b"}


def card_text(card):
    """卡片的一行 JSON，引号字符写成转义，可放进单引号参数。"""
    text = json.dumps(card, ensure_ascii=False, separators=(",", ":"))
    for quote, escaped in QUOTES.items():
        text = text.replace(quote, escaped)
    return text


def check_card(card):
    """卡片自检：card 2.0、蓝色标题、五节按顺序且只有这五节、节间分隔线、大小。"""
    problems = []
    if card.get("schema") != "2.0":
        problems.append("schema 不是 2.0")
    header = card.get("header") or {}
    if not (header.get("title") or {}).get("content", "").startswith("【部门群巡检提醒｜") or header.get("template") != "blue":
        problems.append("标题不是蓝色的「【部门群巡检提醒｜平台】」")
    elements = (card.get("body") or {}).get("elements") or []
    texts = [e for e in elements if e.get("tag") == "markdown"]
    heads = [e.get("content", "").split("\n", 1)[0].strip("*") for e in texts]
    if heads != list(SECTIONS):
        problems.append("章节不是 " + " / ".join(SECTIONS))
    if [e.get("tag") for e in elements] != ["markdown", "hr"] * (len(SECTIONS) - 1) + ["markdown"]:
        problems.append("章节之间没有分隔线")
    size = len(card_text(card).encode("utf-8"))
    if size > MAX_CARD_BYTES:
        problems.append(f"卡片 {size} 字节，超过 {MAX_CARD_BYTES}")
    return problems


def preview(card):
    """卡片的纯文本预览：标题、副标题、各节。"""
    header = card["header"]
    lines = [header["title"]["content"], header["subtitle"]["content"], ""]
    lines += [e["content"].replace("**", "") + "\n" for e in card["body"]["elements"] if e["tag"] == "markdown"]
    return "\n".join(lines).rstrip()


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description="部门巡检卡片")
    ap.add_argument("--items", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    try:
        data = read_json(args.items)
        date, items = validate(data)
        c = classify(items)
        card = build_card(data["platform"], date, c)
        problems = check_card(card)
        if problems:
            raise InputError("卡片自检不通过：" + "；".join(problems))
        os.makedirs(args.out, exist_ok=True)
        with open(os.path.join(args.out, "card.json"), "w", encoding="utf-8") as f:
            f.write(card_text(card))
    except InputError as e:
        print(f"错误: {e}")
        sys.exit(2)
    complete = "不完整" if c["pending"] or c["unjudged"] else "完整"
    print(f"{data['platform']} {date.isoformat()}：需优先关注 {len(c['focus'])}、轻微偏移 {len(c['mild'])}、达标 {len(c['ok'])}、"
          f"待更新 {len(c['pending'])}、目标为空 {len(c['unjudged'])}、辅助项 {len(c['auxiliary'])}；本次提醒完整性：{complete}。")
    print(f"卡片自检通过，已写 {os.path.join(args.out, 'card.json')}。\n\n{preview(card)}")


if __name__ == "__main__":
    main()
