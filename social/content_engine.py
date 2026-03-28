#!/usr/bin/env python3
"""
Social Content Engine - Generates daily posts for Threads
Outputs to social/drafts/ for boss review on dashboard
"""

import json, os, random
from datetime import datetime, timezone, timedelta

DRAFT_DIR = os.path.expanduser("~/.openclaw/workspace/social/drafts")
PUBLISHED_DIR = os.path.expanduser("~/.openclaw/workspace/social/published")
DASHBOARD_FILE = os.path.expanduser("~/.openclaw/workspace/boss-dashboard/social-data.json")

os.makedirs(DRAFT_DIR, exist_ok=True)
os.makedirs(PUBLISHED_DIR, exist_ok=True)

# Content pillars / categories
PILLARS = [
    {
        "id": "market_insight",
        "name": "市場觀察",
        "description": "行銷趨勢、平台演算法變化、消費者行為洞察",
        "examples": ["IG演算法又改了", "短影音紅利結束了嗎", "為什麼你的廣告越投越貴"]
    },
    {
        "id": "practical_tip",
        "name": "實戰技巧",
        "description": "可立即執行的行銷/廣告/社群操作技巧",
        "examples": ["FB廣告受眾設定的3個地雷", "Landing page轉換率提升50%的小改動", "素材測試的正確SOP"]
    },
    {
        "id": "case_study",
        "name": "案例拆解",
        "description": "拆解成功/失敗的品牌行銷案例",
        "examples": ["這個品牌為什麼一夜爆紅", "電商月營收從10萬到100萬做了什麼", "這個銷售頁為什麼轉換率這麼高"]
    },
    {
        "id": "opinion",
        "name": "觀點輸出",
        "description": "對行銷產業的獨立觀點，引發討論",
        "examples": ["行銷人最大的敵人不是演算法", "品牌不需要每天發文", "便宜的設計師為什麼反而更貴"]
    },
    {
        "id": "behind_scenes",
        "name": "幕後分享",
        "description": "工作日常、接案心得、客戶互動（不洩密）",
        "examples": ["今天幫客戶改了一個字轉換率翻倍", "接案5年最常被問的問題", "為什麼我不接這種案子"]
    },
    {
        "id": "value_bomb",
        "name": "乾貨炸彈",
        "description": "高資訊密度的教學型內容",
        "examples": ["2026年行銷預算怎麼分配", "從0到1建立品牌的完整流程", "廣告素材的黃金公式"]
    }
]

def generate_dashboard_data():
    """Read all drafts and published posts, generate dashboard JSON"""
    drafts = []
    published = []
    
    # Read drafts
    if os.path.exists(DRAFT_DIR):
        for f in sorted(os.listdir(DRAFT_DIR), reverse=True):
            if f.endswith('.json'):
                with open(os.path.join(DRAFT_DIR, f)) as fh:
                    drafts.append(json.load(fh))
    
    # Read published
    if os.path.exists(PUBLISHED_DIR):
        for f in sorted(os.listdir(PUBLISHED_DIR), reverse=True)[:20]:
            if f.endswith('.json'):
                with open(os.path.join(PUBLISHED_DIR, f)) as fh:
                    published.append(json.load(fh))
    
    # Stats
    total_published = len([f for f in os.listdir(PUBLISHED_DIR) if f.endswith('.json')]) if os.path.exists(PUBLISHED_DIR) else 0
    
    # Pillar distribution
    pillar_counts = {}
    for p in published:
        pid = p.get('pillar', 'unknown')
        pillar_counts[pid] = pillar_counts.get(pid, 0) + 1
    
    dashboard = {
        "lastUpdate": datetime.now(timezone(timedelta(hours=8))).strftime("%Y-%m-%d %H:%M:%S"),
        "threads": {
            "username": "freeeadman",
            "url": "https://www.threads.com/@freeeadman",
            "apiConfigured": False,
            "totalPublished": total_published,
            "pendingDrafts": len(drafts),
            "pillarDistribution": pillar_counts
        },
        "instagram": {
            "status": "準備中",
            "note": "需要做圖能力，之後再調整"
        },
        "drafts": drafts[:5],  # Show latest 5 drafts
        "recentPublished": published[:10],
        "pillars": [{"id": p["id"], "name": p["name"], "description": p["description"]} for p in PILLARS]
    }
    
    with open(DASHBOARD_FILE, 'w') as f:
        json.dump(dashboard, f, ensure_ascii=False, indent=2)
    
    return dashboard

if __name__ == '__main__':
    d = generate_dashboard_data()
    print(json.dumps(d, ensure_ascii=False, indent=2))
