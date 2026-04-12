#!/usr/bin/env python3
"""
股票推薦覆盤追蹤系統。
- 從 stock-data.json 讀取當前推薦，記錄到 track_history.json
- 用 Yahoo Finance 抓取推薦股的最新價格
- 判斷是否達到目標價或停損價
- 計算整體準確率，回寫 stock-data.json 的 selfReview

用法：
  python3 track_recommendations.py              # 更新追蹤
  python3 track_recommendations.py --snapshot    # 記錄今日推薦快照
"""
import json
import os
import sys
from datetime import datetime

import yfinance as yf

WORKSPACE = os.path.expanduser("~/.openclaw/workspace")
STOCK_JSON = os.path.join(WORKSPACE, "boss-dashboard/stock-data.json")
TRACK_FILE = os.path.join(WORKSPACE, "skills/stock-analysis/track_history.json")

OTC_STOCKS = {"6547", "3529", "6510", "4743", "6488"}


def tw_symbol(code: str) -> str:
    suffix = ".TWO" if code in OTC_STOCKS else ".TW"
    return f"{code}{suffix}"


def get_price(code: str):
    try:
        sym = tw_symbol(code)
        t = yf.Ticker(sym)
        h = t.history(period="5d")
        if h is None or len(h) < 1:
            return None
        return round(float(h.iloc[-1]["Close"]), 2)
    except:
        return None


def load_json(path):
    if os.path.exists(path):
        with open(path, "r") as f:
            return json.load(f)
    return {}


def save_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def parse_target(target_str):
    """Parse target like '1020-1050' → (1020, 1050) or '1020' → (1020, 1020)"""
    if not target_str or target_str == "N/A":
        return None, None
    target_str = str(target_str).replace(",", "").strip()
    if "-" in target_str:
        parts = target_str.split("-")
        try:
            return float(parts[0]), float(parts[1])
        except:
            return None, None
    try:
        v = float(target_str)
        return v, v
    except:
        return None, None


def snapshot(stock_data, track):
    """Record today's recommendations as a snapshot."""
    today = datetime.now().strftime("%Y-%m-%d")
    records = track.setdefault("records", {})

    watchlist = stock_data.get("watchlist", [])
    recs = stock_data.get("recommendations", {})
    all_picks = []

    for item in watchlist:
        all_picks.append({
            "code": item["code"],
            "name": item.get("name", ""),
            "source": "watchlist",
            "category": item.get("category", ""),
            "rec_price": item.get("price", "N/A"),
            "target": item.get("target", "N/A"),
            "stopLoss": item.get("stopLoss", "N/A"),
        })

    for cat in ["ai", "dividend", "etf"]:
        for item in recs.get(cat, []):
            all_picks.append({
                "code": item["code"],
                "name": item.get("name", ""),
                "source": f"rec_{cat}",
                "category": cat,
                "rec_price": item.get("price", "N/A"),
                "target": item.get("target", "N/A"),
                "stopLoss": item.get("stopLoss", "N/A"),
            })

    # Don't overwrite if already snapshot today
    if today in records:
        print(f"⚠️ 今日 ({today}) 已有快照，跳過。如需覆蓋請手動刪除 records['{today}']")
        return track

    records[today] = {
        "picks": all_picks,
        "status": "open",
        "snapshot_time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    }
    print(f"✅ 已記錄 {today} 推薦快照：{len(all_picks)} 檔")
    return track


def update_tracking(track):
    """Update all open records with current prices, check target/stopLoss."""
    records = track.get("records", {})
    stats = {"total": 0, "hit_target": 0, "hit_stop": 0, "open": 0}

    for date, rec in sorted(records.items()):
        if rec.get("status") == "closed":
            # Count closed stats
            for pick in rec.get("picks", []):
                outcome = pick.get("outcome", "")
                stats["total"] += 1
                if outcome == "target_hit":
                    stats["hit_target"] += 1
                elif outcome == "stop_hit":
                    stats["hit_stop"] += 1
            continue

        # Update open records
        all_closed = True
        for pick in rec.get("picks", []):
            if pick.get("outcome"):
                stats["total"] += 1
                if pick["outcome"] == "target_hit":
                    stats["hit_target"] += 1
                elif pick["outcome"] == "stop_hit":
                    stats["hit_stop"] += 1
                continue

            code = pick["code"]
            rec_price = pick.get("rec_price")
            if rec_price == "N/A" or rec_price is None or float(rec_price) == 0:
                continue

            rec_price = float(rec_price)
            current = get_price(code)
            if current is None:
                all_closed = False
                continue

            pick["current_price"] = current
            pick["current_pnl_pct"] = round((current - rec_price) / rec_price * 100, 2)
            pick["last_check"] = datetime.now().strftime("%Y-%m-%d %H:%M")

            target_lo, target_hi = parse_target(pick.get("target"))
            stop = None
            try:
                stop = float(str(pick.get("stopLoss", "")).replace(",", ""))
            except:
                pass

            if target_lo and current >= target_lo:
                pick["outcome"] = "target_hit"
                pick["outcome_price"] = current
                pick["outcome_date"] = datetime.now().strftime("%Y-%m-%d")
                stats["total"] += 1
                stats["hit_target"] += 1
                print(f"  🎯 {code} {pick.get('name','')} 達標！{rec_price} → {current} (+{pick['current_pnl_pct']}%)")
            elif stop and current <= stop:
                pick["outcome"] = "stop_hit"
                pick["outcome_price"] = current
                pick["outcome_date"] = datetime.now().strftime("%Y-%m-%d")
                stats["total"] += 1
                stats["hit_stop"] += 1
                print(f"  🛑 {code} {pick.get('name','')} 停損！{rec_price} → {current} ({pick['current_pnl_pct']}%)")
            else:
                all_closed = False
                stats["open"] += 1
                direction = "📈" if pick["current_pnl_pct"] >= 0 else "📉"
                print(f"  {direction} {code} {pick.get('name','')}: {rec_price} → {current} ({pick['current_pnl_pct']:+.2f}%)")

        if all_closed:
            rec["status"] = "closed"

    track["stats"] = stats
    track["last_update"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    return track, stats


def update_self_review(stock_data, stats):
    """Write stats back to stock-data.json selfReview."""
    total = stats["hit_target"] + stats["hit_stop"]
    rate = f"{stats['hit_target']}/{total} ({round(stats['hit_target']/total*100)}%)" if total > 0 else "追蹤中"

    stock_data["selfReview"] = {
        "totalPicks": stats["total"] + stats["open"],
        "hitTarget": stats["hit_target"],
        "hitStop": stats["hit_stop"],
        "openPositions": stats["open"],
        "correctRate": rate,
        "lastUpdate": datetime.now().strftime("%Y-%m-%d %H:%M"),
    }
    return stock_data


def main():
    do_snapshot = "--snapshot" in sys.argv

    stock_data = load_json(STOCK_JSON)
    track = load_json(TRACK_FILE)

    if do_snapshot:
        print("📸 記錄今日推薦快照...")
        track = snapshot(stock_data, track)
        save_json(TRACK_FILE, track)
        print("✅ 快照已儲存")
        return

    # Default: update tracking
    print("🔄 更新推薦追蹤...")
    if not track.get("records"):
        print("⚠️ 沒有歷史快照。先跑 --snapshot 記錄今日推薦。")
        print("   自動記錄中...")
        track = snapshot(stock_data, track)

    track, stats = update_tracking(track)
    save_json(TRACK_FILE, track)

    # Update selfReview in stock-data.json
    stock_data = update_self_review(stock_data, stats)
    save_json(STOCK_JSON, stock_data)

    print(f"\n📊 覆盤統計：")
    print(f"   達標：{stats['hit_target']} | 停損：{stats['hit_stop']} | 追蹤中：{stats['open']}")
    total = stats['hit_target'] + stats['hit_stop']
    if total > 0:
        print(f"   準確率：{stats['hit_target']}/{total} ({round(stats['hit_target']/total*100)}%)")
    print("✅ 已更新 stock-data.json selfReview")


if __name__ == "__main__":
    main()
