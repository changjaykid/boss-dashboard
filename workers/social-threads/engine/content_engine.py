#!/usr/bin/env python3
"""
Social Content Engine v2 — 讀寫唯一來源 dashboard.json
不碰 drafts/ published/ boss-dashboard/
"""

import json, os
from datetime import datetime, timezone, timedelta

WORKER_DIR = os.path.join(os.path.dirname(__file__), '..')
DASHBOARD_FILE = os.path.join(WORKER_DIR, 'dashboard.json')

PILLARS = [
    {"id": "market_insight", "name": "市場觀察"},
    {"id": "practical_tip", "name": "實戰技巧"},
    {"id": "case_study", "name": "案例拆解"},
    {"id": "opinion", "name": "觀點輸出"},
    {"id": "behind_scenes", "name": "幕後分享"},
    {"id": "value_bomb", "name": "乾貨炸彈"},
    {"id": "casual_vibes", "name": "輕鬆日常"},
    {"id": "data_insight", "name": "數據解讀"},
]

def load_dashboard():
    with open(DASHBOARD_FILE) as f:
        return json.load(f)

def save_dashboard(data):
    data['lastUpdate'] = datetime.now(timezone(timedelta(hours=8))).strftime("%Y/%m/%d %H:%M")
    with open(DASHBOARD_FILE, 'w') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

def get_recent_pillars(dashboard, n=5):
    """回傳最近 n 篇的 pillar，用來避免重複"""
    published = dashboard.get('published', [])
    return [p.get('pillar', '') for p in published[:n]]

def add_draft(dashboard, draft_id, pillar_id, pillar_name, content, suggested_time='11:00'):
    """新增草稿到 dashboard.json"""
    draft = {
        'id': draft_id,
        'platform': 'threads',
        'pillar': pillar_id,
        'pillar_name': pillar_name,
        'created': datetime.now(timezone(timedelta(hours=8))).strftime("%Y-%m-%d %H:%M"),
        'suggestedTime': suggested_time,
        'status': 'pending',
        'content': content
    }
    dashboard.setdefault('drafts', []).append(draft)
    save_dashboard(dashboard)
    return draft

if __name__ == '__main__':
    d = load_dashboard()
    print(f"Drafts: {len(d.get('drafts', []))}")
    print(f"Published: {len(d.get('published', []))}")
    recent = get_recent_pillars(d)
    print(f"Recent pillars: {recent}")
