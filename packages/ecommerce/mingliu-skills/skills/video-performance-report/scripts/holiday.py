#!/usr/bin/env python3
"""判断某天是不是中国大陆法定节假日（chinese_calendar，随 MO 自带 Python 提供）。

用法:
    python3 holiday.py <YYYY-MM-DD>

输出一行 JSON（UTF-8）:
    {"date": "2026-10-01", "holiday": true, "name": "National Day"}
    {"date": "2026-10-12", "holiday": false, "name": null}

「法定节假日」只算有节日名的放假日（含调休放假的工作日）；普通周末不算。
退出码: 0 = 已判断；1 = 参数不是日期；2 = 判断不了（chinese_calendar 缺失或不含这一年），此时不要发送。
"""
import datetime
import json
import re
import sys


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    try:
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", sys.argv[1]):
            raise ValueError(sys.argv[1])
        day = datetime.date.fromisoformat(sys.argv[1])
    except (IndexError, ValueError):
        print("错误: 需要一个 YYYY-MM-DD 日期参数")
        sys.exit(1)
    try:
        import chinese_calendar
        on_holiday, name = chinese_calendar.get_holiday_detail(day)
    except (ImportError, NotImplementedError) as e:
        print(f"错误: 判断不了 {day} 是否为法定节假日：{e}")
        sys.exit(2)
    holiday = bool(on_holiday and name)
    print(json.dumps({"date": day.isoformat(), "holiday": holiday, "name": name if holiday else None}, ensure_ascii=False))


if __name__ == "__main__":
    main()
