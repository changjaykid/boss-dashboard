#!/usr/bin/env python3
"""
Crypto Prices Updater
=====================
從 Yahoo Finance + alternative.me 抓取真實幣價，更新 crypto-news.json 的 prices 欄位。
不動新聞內容。

用法: python3 update_crypto_prices.py [--json-path PATH]
預設 JSON 路徑: ../../boss-dashboard/crypto-news.json (相對於腳本位置)
"""

import json
import os
import sys
import argparse
from datetime import datetime, timezone, timedelta

# Suppress warnings
import warnings
warnings.filterwarnings("ignore")

def get_json_path(custom_path=None):
    if custom_path:
        return custom_path
    script_dir = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(script_dir, "..", "..", "..", "boss-dashboard", "crypto-news.json")

def fetch_yfinance_prices():
    """從 Yahoo Finance 抓取幣價和匯率"""
    import yfinance as yf

    tickers = {
        "BTC-USD": "BTC/USD",
        "ETH-USD": "ETH/USD",
        "SOL-USD": "SOL/USD",
        "DOGE-USD": "DOGE/USD",
        "TWD=X": "USD/TWD",
    }

    results = {}
    print("[yfinance] 抓取中...")

    for symbol, label in tickers.items():
        try:
            t = yf.Ticker(symbol)
            info = t.fast_info
            price = getattr(info, "last_price", None)
            prev_close = getattr(info, "previous_close", None)

            if price is None:
                # fallback: use history
                hist = t.history(period="2d")
                if not hist.empty:
                    price = float(hist["Close"].iloc[-1])
                    if len(hist) >= 2:
                        prev_close = float(hist["Close"].iloc[-2])

            if price is not None:
                change_pct = None
                if prev_close and prev_close > 0:
                    change_pct = round((price - prev_close) / prev_close * 100, 2)
                results[label] = {"price": round(price, 4), "change_pct": change_pct}
                print(f"  ✅ {label}: {price:.4f} ({'+' if change_pct and change_pct >= 0 else ''}{change_pct}%)")
            else:
                results[label] = {"price": "N/A", "change_pct": "N/A"}
                print(f"  ❌ {label}: N/A")
        except Exception as e:
            results[label] = {"price": "N/A", "change_pct": "N/A"}
            print(f"  ❌ {label}: error - {e}")

    return results

def fetch_fear_greed():
    """從 alternative.me 抓取恐懼貪婪指數"""
    import urllib.request
    print("[FnG] 抓取恐懼貪婪指數...")
    try:
        url = "https://api.alternative.me/fng/?limit=1"
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode())
        entry = data["data"][0]
        value = int(entry["value"])
        classification = entry["value_classification"]
        print(f"  ✅ Fear & Greed: {value} ({classification})")
        return {"value": value, "classification": classification}
    except Exception as e:
        print(f"  ❌ Fear & Greed: error - {e}")
        return {"value": "N/A", "classification": "N/A"}

def compute_twd_prices(yf_data):
    """用 BTC-USD * USD/TWD 算出 TWD 幣價"""
    usd_twd = yf_data.get("USD/TWD", {}).get("price")
    twd_prices = {}

    for coin in ["BTC", "ETH"]:
        usd_key = f"{coin}/USD"
        twd_key = f"{coin}/TWD"
        usd_price = yf_data.get(usd_key, {}).get("price")
        usd_change = yf_data.get(usd_key, {}).get("change_pct")

        if usd_price != "N/A" and usd_twd != "N/A" and usd_price and usd_twd:
            twd_price = round(float(usd_price) * float(usd_twd), 0)
            twd_prices[twd_key] = {"price": int(twd_price), "change_pct": usd_change}
            print(f"  ✅ {twd_key}: {twd_price:,.0f} TWD")
        else:
            twd_prices[twd_key] = {"price": "N/A", "change_pct": "N/A"}
            print(f"  ❌ {twd_key}: N/A (缺 USD 價或匯率)")

    return twd_prices

def build_prices_block(yf_data, twd_data, fng):
    """組裝 prices 物件"""
    tz = timezone(timedelta(hours=8))
    now = datetime.now(tz).strftime("%Y-%m-%d %H:%M:%S")

    def fmt(data, key, decimals=2):
        d = data.get(key, {"price": "N/A", "change_pct": "N/A"})
        p = d["price"]
        c = d["change_pct"]
        if p != "N/A" and isinstance(p, (int, float)):
            p = round(p, decimals)
        return {"price": p, "change_pct": c}

    return {
        "fetchedAt": now,
        "source": "Yahoo Finance + alternative.me",
        "BTC_USD": fmt(yf_data, "BTC/USD", 2),
        "ETH_USD": fmt(yf_data, "ETH/USD", 2),
        "SOL_USD": fmt(yf_data, "SOL/USD", 2),
        "DOGE_USD": fmt(yf_data, "DOGE/USD", 4),
        "BTC_TWD": fmt(twd_data, "BTC/TWD", 0),
        "ETH_TWD": fmt(twd_data, "ETH/TWD", 0),
        "USD_TWD": fmt(yf_data, "USD/TWD", 4),
        "fearGreedIndex": fng,
    }

def main():
    parser = argparse.ArgumentParser(description="Update crypto prices in crypto-news.json")
    parser.add_argument("--json-path", help="Path to crypto-news.json")
    args = parser.parse_args()

    json_path = get_json_path(args.json_path)
    json_path = os.path.abspath(json_path)
    print(f"📄 JSON 路徑: {json_path}")

    # 讀取現有 JSON
    existing = {}
    if os.path.exists(json_path):
        try:
            with open(json_path, "r", encoding="utf-8") as f:
                existing = json.load(f)
            print("📂 已讀取現有 crypto-news.json")
        except Exception as e:
            print(f"⚠️ 讀取失敗，將建立新檔: {e}")

    # 抓取價格
    yf_data = fetch_yfinance_prices()
    fng = fetch_fear_greed()

    print("\n[換算] TWD 幣價...")
    twd_data = compute_twd_prices(yf_data)

    # 組裝 prices
    prices = build_prices_block(yf_data, twd_data, fng)

    # 只更新 prices 欄位，其他不動
    existing["prices"] = prices
    print(f"\n💾 寫入 {json_path}")
    os.makedirs(os.path.dirname(json_path), exist_ok=True)
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(existing, f, ensure_ascii=False, indent=2)

    print("✅ 完成！prices 欄位已更新。")
    # 輸出摘要
    print("\n📊 價格摘要:")
    for key in ["BTC_USD", "ETH_USD", "SOL_USD", "DOGE_USD", "BTC_TWD", "ETH_TWD"]:
        p = prices.get(key, {})
        price_val = p.get("price", "N/A")
        change = p.get("change_pct", "N/A")
        print(f"  {key}: {price_val}  ({'+' if isinstance(change, (int, float)) and change >= 0 else ''}{change}%)")
    fng_val = prices["fearGreedIndex"]
    print(f"  Fear & Greed: {fng_val.get('value', 'N/A')} ({fng_val.get('classification', 'N/A')})")

if __name__ == "__main__":
    main()
