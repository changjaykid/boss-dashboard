#!/usr/bin/env python3
"""
Forex & Index Price Updater
從 Yahoo Finance (yfinance) 抓取即時/收盤價，更新 forex-news.json 的 prices 區塊。
不動新聞、社群討論、總結等模型產生的內容。

Usage: python3 update_forex_prices.py [--json-path PATH]
Default json path: ../../boss-dashboard/forex-news.json (relative to script)
"""

import argparse
import json
import os
import sys
from datetime import datetime, timezone, timedelta

try:
    import yfinance as yf
except ImportError:
    print("ERROR: yfinance not installed. Run: pip3 install yfinance", file=sys.stderr)
    sys.exit(1)

# ── Symbol mapping ──
# key = display name, value = (yahoo symbol, display_type)
INSTRUMENTS = {
    "XAUUSD": {"symbol": "GC=F", "label": "黃金 XAUUSD", "unit": "USD/oz"},
    "EURUSD": {"symbol": "EURUSD=X", "label": "歐元/美元", "unit": ""},
    "GBPUSD": {"symbol": "GBPUSD=X", "label": "英鎊/美元", "unit": ""},
    "USDJPY": {"symbol": "JPY=X", "label": "美元/日圓", "unit": ""},
    "US30":   {"symbol": "^DJI", "label": "道瓊工業 US30", "unit": ""},
    "SPX500": {"symbol": "^GSPC", "label": "標普500", "unit": ""},
    "NAS100": {"symbol": "NQ=F", "label": "那斯達克100期貨", "unit": ""},
    "DXY":    {"symbol": "DX-Y.NYB", "label": "美元指數 DXY", "unit": ""},
    "US10Y":  {"symbol": "^TNX", "label": "美國10年期公債殖利率", "unit": "%"},
}

# Fallback symbols if primary fails
FALLBACKS = {
    "XAUUSD": "GLD",
    "NAS100": "^IXIC",
    "USDJPY": "USDJPY=X",
}


def fetch_price(key: str, info: dict) -> dict:
    """Fetch price for a single instrument. Returns a price dict."""
    symbol = info["symbol"]
    result = {
        "key": key,
        "label": info["label"],
        "unit": info["unit"],
        "price": "N/A",
        "change": "N/A",
        "changePercent": "N/A",
        "symbol": symbol,
        "fetchedAt": datetime.now(timezone(timedelta(hours=8))).strftime("%Y-%m-%d %H:%M:%S"),
    }

    symbols_to_try = [symbol]
    if key in FALLBACKS:
        symbols_to_try.append(FALLBACKS[key])

    for sym in symbols_to_try:
        try:
            ticker = yf.Ticker(sym)
            # Try fast_info first, then info
            try:
                price = ticker.fast_info.get("lastPrice") or ticker.fast_info.get("last_price")
                prev_close = ticker.fast_info.get("previousClose") or ticker.fast_info.get("previous_close")
            except Exception:
                price = None
                prev_close = None

            if price is None:
                hist = ticker.history(period="2d")
                if len(hist) >= 1:
                    price = float(hist["Close"].iloc[-1])
                    if len(hist) >= 2:
                        prev_close = float(hist["Close"].iloc[-2])

            if price is not None:
                result["price"] = round(float(price), 4) if float(price) < 10 else round(float(price), 2)
                result["symbol"] = sym

                if prev_close is not None and float(prev_close) > 0:
                    change = float(price) - float(prev_close)
                    change_pct = (change / float(prev_close)) * 100
                    result["change"] = round(change, 4) if abs(change) < 1 else round(change, 2)
                    result["changePercent"] = f"{change_pct:+.2f}%"

                return result

        except Exception as e:
            print(f"  Warning: {sym} failed: {e}", file=sys.stderr)
            continue

    print(f"  ERROR: All symbols failed for {key}", file=sys.stderr)
    return result


def main():
    parser = argparse.ArgumentParser(description="Update forex prices in forex-news.json")
    script_dir = os.path.dirname(os.path.abspath(__file__))
    default_json = os.path.join(script_dir, "..", "..", "..", "boss-dashboard", "forex-news.json")
    parser.add_argument("--json-path", default=default_json, help="Path to forex-news.json")
    args = parser.parse_args()

    json_path = os.path.abspath(args.json_path)
    print(f"📊 Forex Price Updater")
    print(f"   JSON path: {json_path}")
    print(f"   Time: {datetime.now(timezone(timedelta(hours=8))).strftime('%Y-%m-%d %H:%M:%S')} (Asia/Taipei)")
    print()

    # Load existing JSON (preserve news/discussions/conclusion)
    existing = {}
    if os.path.exists(json_path):
        try:
            with open(json_path, "r", encoding="utf-8") as f:
                existing = json.load(f)
            print(f"   Loaded existing JSON ({len(existing.get('news', []))} news items preserved)")
        except Exception as e:
            print(f"   Warning: Could not load existing JSON: {e}", file=sys.stderr)

    # Fetch all prices
    prices = {}
    print(f"\n🔄 Fetching prices for {len(INSTRUMENTS)} instruments...")
    for key, info in INSTRUMENTS.items():
        print(f"   {key} ({info['symbol']})...", end=" ", flush=True)
        p = fetch_price(key, info)
        prices[key] = p
        if p["price"] != "N/A":
            print(f"✅ {p['price']} ({p['changePercent']})")
        else:
            print("❌ N/A")

    # Build prices block
    prices_block = {
        "fetchedAt": datetime.now(timezone(timedelta(hours=8))).strftime("%Y-%m-%d %H:%M:%S"),
        "source": "Yahoo Finance (yfinance)",
        "instruments": prices,
    }

    # Merge: update prices, keep everything else
    existing["prices"] = prices_block
    # Update lastUpdate timestamp
    existing["lastUpdate"] = datetime.now(timezone(timedelta(hours=8))).strftime("%Y-%m-%d %H:%M:%S")

    # Ensure output dir exists
    os.makedirs(os.path.dirname(json_path), exist_ok=True)

    # Write back
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(existing, f, ensure_ascii=False, indent=2)

    print(f"\n✅ Done! Prices written to {json_path}")

    # Summary
    ok_count = sum(1 for p in prices.values() if p["price"] != "N/A")
    fail_count = len(prices) - ok_count
    print(f"   Success: {ok_count}/{len(prices)}, Failed: {fail_count}")

    if fail_count > 0:
        failed = [k for k, p in prices.items() if p["price"] == "N/A"]
        print(f"   Failed instruments: {', '.join(failed)}")

    return 0 if fail_count == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
