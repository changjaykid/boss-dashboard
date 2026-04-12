#!/usr/bin/env python3
"""
從 Yahoo Finance 抓取真實收盤價 + 基本面數據，更新 stock-data.json。
所有數字資料由此腳本產生，模型不可自行編造。

用法：
  python3 update_stock_prices.py [--json-path PATH]
"""
import json
import os
import sys
from datetime import datetime

import yfinance as yf

DEFAULT_JSON = os.path.expanduser(
    "~/.openclaw/workspace/boss-dashboard/stock-data.json"
)

# 上櫃股用 .TWO，上市股用 .TW
OTC_STOCKS = {"6547", "3529", "6510", "4743", "6488"}

# ── Market indices ──────────────────────────────────────────
INDEX_MAP = {
    "taiex": "^TWII",
    "djia": "^DJI",
    "sp500": "^GSPC",
    "nasdaq": "^IXIC",
    "tsmc_adr": "TSM",
}

OIL_MAP = {
    "wti": "CL=F",
    "brent": "BZ=F",
}


def tw_symbol(code: str) -> str:
    """Return Yahoo Finance symbol for a TW stock code."""
    suffix = ".TWO" if code in OTC_STOCKS else ".TW"
    return f"{code}{suffix}"


def get_last_close(ticker_symbol: str, period: str = "5d"):
    """Get the most recent close price, change, and change%."""
    try:
        t = yf.Ticker(ticker_symbol)
        h = t.history(period=period)
        if h is None or len(h) < 1:
            return None, None, None
        last = h.iloc[-1]
        close = round(float(last["Close"]), 2)
        if len(h) >= 2:
            prev = h.iloc[-2]
            change = round(close - float(prev["Close"]), 2)
            change_pct = round(change / float(prev["Close"]) * 100, 2)
        else:
            change, change_pct = 0, 0
        return close, change, change_pct
    except Exception as e:
        print(f"  ⚠️ {ticker_symbol}: {e}", file=sys.stderr)
        return None, None, None


def get_fundamentals(ticker_symbol: str):
    """Get P/E, P/B, dividend yield, last dividend date/amount from yfinance."""
    result = {}
    try:
        t = yf.Ticker(ticker_symbol)
        info = t.info or {}
        # P/E ratio
        pe = info.get("trailingPE") or info.get("forwardPE")
        if pe and pe > 0:
            result["pe"] = round(float(pe), 2)
        # P/B ratio
        pb = info.get("priceToBook")
        if pb and pb > 0:
            result["pb"] = round(float(pb), 2)
        # Dividend yield
        dy = info.get("dividendYield") or info.get("trailingAnnualDividendYield")
        if dy and dy > 0:
            result["dividendYield"] = round(float(dy) * 100, 2)  # as %
        # Last dividend
        ldv = info.get("lastDividendValue")
        if ldv and ldv > 0:
            result["lastDividendPerShare"] = round(float(ldv), 2)
        ldd = info.get("exDividendDate")
        if ldd:
            # yfinance returns epoch seconds
            try:
                result["exDividendDate"] = datetime.fromtimestamp(int(ldd)).strftime("%Y-%m-%d")
            except Exception:
                pass
    except Exception as e:
        print(f"  ⚠️ fundamentals {ticker_symbol}: {e}", file=sys.stderr)
    return result


def update_list_prices(items: list, label: str, fetch_fundamentals: bool = True):
    """Update price + fundamentals for a list of stock dicts with 'code' key."""
    print(f"\n📋 {label}:")
    for item in items:
        code = item.get("code", "")
        symbol = tw_symbol(code)
        close, change, pct = get_last_close(symbol)
        if close is None:
            print(f"  ❌ {code} {item.get('name','')}: failed → N/A")
            item["price"] = "N/A"
            continue
        old = item.get("price", "N/A")
        item["price"] = close
        sign = "+" if change and change >= 0 else ""
        print(f"  ✅ {code} {item.get('name','')}: {old} → {close} ({sign}{change})")

        # Fetch fundamentals
        if fetch_fundamentals:
            fund = get_fundamentals(symbol)
            if fund:
                for k, v in fund.items():
                    item[k] = v
                extras = ", ".join(f"{k}={v}" for k, v in fund.items())
                print(f"     📊 {extras}")


def main():
    json_path = DEFAULT_JSON
    if "--json-path" in sys.argv:
        idx = sys.argv.index("--json-path")
        if idx + 1 < len(sys.argv):
            json_path = sys.argv[idx + 1]

    if not os.path.exists(json_path):
        print(f"❌ {json_path} not found", file=sys.stderr)
        sys.exit(1)

    with open(json_path, "r") as f:
        data = json.load(f)

    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"⏰ Updating stock prices at {now_str}")

    # ── 1. Market indices ───────────────────────────────────
    print("\n📊 Market indices:")
    for key, symbol in INDEX_MAP.items():
        close, change, pct = get_last_close(symbol)
        if close is None:
            print(f"  ❌ {key} ({symbol}): failed")
            continue
        print(f"  ✅ {key}: {close} ({change:+.2f}, {pct:+.2f}%)")

        if key == "taiex":
            data.setdefault("market", {}).setdefault("taiex", {})
            data["market"]["taiex"].update(
                {"close": close, "change": change, "changePct": pct}
            )
        elif key == "tsmc_adr":
            data.setdefault("market", {}).setdefault("tsmc_adr", {})
            data["market"]["tsmc_adr"].update({"close": close, "change": change})
        else:
            data.setdefault("market", {}).setdefault("usMarket", {}).setdefault(key, {})
            data["market"]["usMarket"][key].update(
                {"close": close, "change": change, "changePct": pct}
            )

    # Oil
    print("\n🛢️ Oil:")
    data.setdefault("market", {}).setdefault("oil", {})
    for key, symbol in OIL_MAP.items():
        close, _, _ = get_last_close(symbol)
        if close is None:
            print(f"  ❌ {key}: failed")
            continue
        print(f"  ✅ {key}: {close}")
        data["market"]["oil"][key] = close

    # ── 2. Watchlist ────────────────────────────────────────
    update_list_prices(data.get("watchlist", []), "Watchlist")

    # ── 3. Recommendations ──────────────────────────────────
    recs = data.get("recommendations", {})
    for category in ["ai", "dividend", "etf"]:
        update_list_prices(recs.get(category, []), f"Recommendations [{category}]")

    # ── 4. Metadata ─────────────────────────────────────────
    data["lastUpdate"] = now_str
    data["dataSource"] = "Yahoo Finance (yfinance)"

    with open(json_path, "w") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    print(f"\n✅ Done! Updated {json_path}")


if __name__ == "__main__":
    main()
