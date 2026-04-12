#!/usr/bin/env python3
"""
Sync IG carousel output data to boss-dashboard/ig-data.json
Reads from ig-carousel/output/ and ig-carousel/captions/
"""
import json, os, glob
from datetime import datetime

WORKSPACE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUTPUT_DIR = os.path.join(WORKSPACE, "ig-carousel", "output")
CAPTIONS_DIR = os.path.join(WORKSPACE, "ig-carousel", "captions")
DASHBOARD_FILE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "dashboard.json")

def main():
    posts = []
    
    if os.path.isdir(OUTPUT_DIR):
        for folder in sorted(os.listdir(OUTPUT_DIR), reverse=True)[:20]:
            folder_path = os.path.join(OUTPUT_DIR, folder)
            if not os.path.isdir(folder_path):
                continue
            
            slides = sorted(glob.glob(os.path.join(folder_path, "*.png")))
            slide_count = len(slides)
            if slide_count == 0:
                continue
            
            # Try to read caption
            caption = ""
            caption_file = os.path.join(CAPTIONS_DIR, f"{folder}.txt")
            if os.path.isfile(caption_file):
                with open(caption_file, "r", encoding="utf-8") as f:
                    caption = f.read().strip()
            
            # Try to read draft json for metadata
            draft_file = os.path.join(WORKSPACE, "ig-carousel", "drafts", f"{folder}.json")
            title = folder
            bg_mode = "solid"
            if os.path.isfile(draft_file):
                try:
                    with open(draft_file, "r", encoding="utf-8") as f:
                        draft = json.load(f)
                    title = draft.get("title", folder)
                    bg_mode = draft.get("bg_mode", "solid")
                except:
                    pass
            
            # Get modification time
            mtime = os.path.getmtime(folder_path)
            created = datetime.fromtimestamp(mtime).strftime("%Y-%m-%d %H:%M")
            
            posts.append({
                "id": folder,
                "title": title,
                "slides": slide_count,
                "bgMode": bg_mode,
                "caption": caption[:200] + ("..." if len(caption) > 200 else ""),
                "created": created,
                "uploaded": True  # Assume uploaded if exists
            })
    
    data = {
        "lastUpdate": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "totalPosts": len(posts),
        "driveLink": "https://drive.google.com/drive/folders/1RCam8Dgpk5x-oMlfLHXQmMhKKv5z4KB2",
        "posts": posts
    }
    
    with open(DASHBOARD_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    
    print(f"✅ IG data synced: {len(posts)} posts → {DASHBOARD_FILE}")

if __name__ == "__main__":
    main()
