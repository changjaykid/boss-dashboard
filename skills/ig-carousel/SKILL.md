---
name: ig-carousel
description: "IG carousel image + caption generation system for @freeeadman. Produces 1080x1350 carousel posts (5-7 slides) with magazine-quality design, AI-generated photo backgrounds, and accompanying captions + hashtags. Content covers advertising, marketing, branding, data, e-commerce, and social media. Use when: (1) running scheduled IG content cron (11:00/18:00), (2) boss asks to create IG carousel content, (3) boss requests revisions to a carousel draft, (4) any task involving Instagram visual content for @freeeadman. NOT for Threads text posts (use social-posting skill)."
---

# IG Carousel System — @freeeadman

## Overview

每日 2 組 IG 輪播圖文，展示行銷專業實力。圖片用程式模板精確渲染（固定 UI、中文字體），AI 負責產文案內容和背景圖。

**設計定位**：現代、成熟、有質感、知識型，高級雜誌封面與品牌海報的感覺。絕對不要廉價模板感、電商促銷感、學生簡報感或 AI 海報感。

## Architecture

```
skills/ig-carousel/
├── SKILL.md
├── scripts/
│   ├── generate_carousel.py   # Pillow-based image generator
│   ├── generate_bg.py         # AI background generator
│   └── upload_to_drive.sh     # Google Drive upload helper
├── references/
│   ├── design-spec.md         # 設計規範（排版/背景/色彩/字體）
│   ├── quality-standard.md    # 內容品質標準
│   ├── carousel-structures.md # Slide structure templates
│   └── ig-caption-rules.md    # Caption + hashtag rules
└── assets/
    └── backgrounds/           # Optional background images

ig-carousel/                   # Working directory (workspace root)
├── output/                    # Generated images (per-post folders)
├── drafts/                    # Draft JSON files
└── captions/                  # Caption text files
```

## Complete Workflow

### 1. Generate Content (11:00 / 18:00 cron)

a. **Pick topic**: 參考 `references/quality-standard.md` 的 12 大內容方向。
   - 連續 2 篇不可重複同方向
   - 同一天兩篇必須不同方向
   - 每週至少覆蓋 4 個不同方向
   - ⚠️ 標題風格多元：疑問句、陳述句、數字句、故事句交替
   - ⚠️ 先想清楚：這篇打哪類人、他們看什麼有感、為什麼收藏/分享

b. **Choose structure**: See `references/carousel-structures.md` for 9+ 種結構模板。
   - 連續 2 篇不可用同一結構

c. **Write slide content**: Create a JSON data file.

**⚠️ 統一使用照片背景風格**：
- `"bg_mode": "photo"`, `"bg_per_slide": true`
- `"bg_darken"`: 0.40-0.55（不要壓太暗，保留環境細節和呼吸感）
- 背景場景每天不同，但風格一致（見 `references/design-spec.md`）
- 品牌強調色固定：焦糖橘 #D4874D

```json
{
  "id": "YYYYMMDD-NNN",
  "title": "Post title for reference",
  "bg_mode": "photo",
  "bg_per_slide": true,
  "bg_darken": 0.45,
  "accent_color": "#D4874D",
  "slides": [
    {"type": "cover", "headline": "強 Hook 標題", "subtitle": "可選副標"},
    {"type": "content", "headline": "小標", "body": "內容推進"},
    {"type": "steps", "headline": "小標", "items": ["步驟一", "步驟二", "步驟三"]},
    {"type": "highlight", "headline": "重點金句"},
    {"type": "cta", "headline": "行動呼籲", "body": "引導文"}
  ]
}
```
每篇必須 5-7 張圖。Save to `ig-carousel/drafts/{id}.json`.

**⚠️ 品質門檻**：寫完後必須通過 `references/quality-standard.md` 的「產出前三問」，任一不過就重寫：
1. 這篇有沒有讓人收藏的理由？
2. 這篇有沒有讓同行想分享給同事的價值？
3. 這篇有沒有讓潛在客戶覺得你很懂？

**⚠️ 內容要求**：
- 封面 Hook 必須有衝突感/反直覺/痛點/好奇/結果感，不要平鋪直敘
- 每張圖有明確功能，不能重複、不能只換句話說，有節奏推進
- 有實戰感（做過、看過、踩過坑），不是只講理論
- CTA 自然不硬銷，可邀請索取清單/模板/架構/檢查表等
- 語氣專業但像真人在說話，有觀點有判斷有經驗

d. **Generate AI backgrounds**:
```bash
export PATH="$HOME/.local/bin:$PATH"
uv run skills/ig-carousel/scripts/generate_bg.py \
  --data ig-carousel/drafts/{id}.json \
  --output ig-carousel/output/{id}/backgrounds/ \
  --resolution 1K
```
背景 prompt 要求（見 `references/design-spec.md`）：
- 場景：暖灰/深咖/煙燻棕/霧黑色調的都會空間、建築、街景、室內
- 關鍵字：editorial photography, soft ambient lighting, atmospheric haze, shallow depth of field
- 排除：NOT dark, NOT moody, NOT black, NOT neon, NOT cartoon

e. **Generate final images** (overlays text + UI on backgrounds):
```bash
python3 skills/ig-carousel/scripts/generate_carousel.py \
  --data ig-carousel/drafts/{id}.json \
  --output ig-carousel/output/{id}/
```

f. **Write caption**: See `references/ig-caption-rules.md`. Save to `ig-carousel/captions/{id}.txt`.
   - IG caption 精煉有力，不像 Threads 長篇
   - 第一行是鉤子（被摺疊前看到的）
   - 結尾 CTA + 5-10 個精準 hashtags

g. **Upload to Google Drive**:
```bash
skills/ig-carousel/scripts/upload_to_drive.sh \
  ig-carousel/output/{id}/ \
  GOOGLE_DRIVE_FOLDER_ID
```
Also upload the caption file.

h. **Sync dashboard data**:
```bash
python3 scripts/sync_ig_data.py
cd boss-dashboard && git add -A && git commit -m "update ig data" && git push origin main
```

i. **Notify boss via LINE**: 「IG 第 N 篇已上傳到雲端，主題：XXX」

### 2. Boss Review

**Boss approves** → Record in log, no further action needed (boss posts manually)

**Boss requests changes** →
- If text change: Update JSON → regenerate → re-upload
- If style/design change: Adjust theme or structure → regenerate → re-upload
- If complete redo: New topic → full workflow from step 1

### 3. File Naming Convention

Images: `YYYYMMDD-NNN_slideN.png` (e.g. `20260401-001_slide1.png`)
Captions: `YYYYMMDD-NNN_caption.txt`
Drive folder structure: `IG素材/YYYY-MM-DD/` (每天一個日期資料夾)

## Quality Checklist (before upload)

### 設計品質
- [ ] 排版左對齊、大標主導、大量留白
- [ ] 背景有空氣感光影感，不是純黑悶住
- [ ] 字體清楚易讀、層級分明（標題 > 重點 > 內文）
- [ ] 強調色一致（焦糖橘 #D4874D）
- [ ] 整體像高級雜誌/品牌海報，不像廉價模板
- [ ] UI 元素低調不搶畫面

### 內容品質
- [ ] 通過「產出前三問」（收藏/分享/信任）
- [ ] 封面 Hook 有衝突感/反直覺/痛點/好奇/結果感
- [ ] 每張圖有明確功能，無水頁
- [ ] CTA 自然不硬銷
- [ ] 有實戰感、觀點感、可操作性
- [ ] Caption 精煉有力、真人口吻
- [ ] 5-10 個精準 hashtags
- [ ] 無「——」、無年份、無 AI 套話
- [ ] 連續篇方向/結構不重複

## Topic Pillars

12 大方向（必須輪流，見 `references/quality-standard.md`）：
趨勢解讀、實戰技巧、案例拆解、觀點輸出、幕後分享、乾貨炸彈、工具推薦、客戶溝通、品牌思維、創業真相、數據解讀、產業八卦

## Voice Variety

輪替使用：
- 專業分析 / 輕鬆分享 / 犀利觀點 / 故事敘述

## Google Drive Setup

- Account: socialobservertw@gmail.com
- Auth: via gog CLI (OAuth configured)
- Upload command: `gog drive upload <file> --parent <folder_id>`
- IG素材 folder ID: `1RCam8Dgpk5x-oMlfLHXQmMhKKv5z4KB2`
- Link: https://drive.google.com/drive/folders/1RCam8Dgpk5x-oMlfLHXQmMhKKv5z4KB2

## Cron Schedule

- `ig-morning` — 11:00 Asia/Taipei (first carousel)
- `ig-evening` — 18:00 Asia/Taipei (second carousel)
- Model: gpt-4o-mini for content generation (save Opus tokens)

## Dependencies

- Python 3 + Pillow (image generation)
- uv + google-genai (Nano Banana Pro AI backgrounds)
- GEMINI_API_KEY environment variable
- gog CLI (Google Drive upload)
- Shares brand-voice and content pillars with social-posting skill
