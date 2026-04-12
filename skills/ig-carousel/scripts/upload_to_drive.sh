#!/bin/bash
# Upload IG carousel files to Google Drive with date folder structure
# Usage: upload_to_drive.sh <source_dir> [caption_file]
# 
# Automatically creates a date folder (YYYY-MM-DD) under IG素材
# IG素材 folder ID: 1RCam8Dgpk5x-oMlfLHXQmMhKKv5z4KB2

set -e

IG_ROOT="1RCam8Dgpk5x-oMlfLHXQmMhKKv5z4KB2"
SOURCE_DIR="$1"
CAPTION_FILE="$2"
TIME_SLOT="${3:-}"  # Optional: 11 or 18

if [ -n "$TIME_SLOT" ]; then
  TODAY="$(date +%Y-%m-%d)-${TIME_SLOT}"
else
  TODAY=$(date +%Y-%m-%d)
fi

if [ -z "$SOURCE_DIR" ]; then
  echo "Usage: $0 <source_dir> [caption_file]"
  exit 1
fi

# Create date folder
echo "Creating folder: $TODAY"
FOLDER_JSON=$(gog drive mkdir "$TODAY" --parent "$IG_ROOT" -j 2>&1)
FOLDER_ID=$(echo "$FOLDER_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['folder']['id'])")
echo "Folder ID: $FOLDER_ID"

# Upload all images
for f in "$SOURCE_DIR"/*.png; do
  [ -f "$f" ] || continue
  echo "Uploading $(basename $f)..."
  gog drive upload "$f" --parent "$FOLDER_ID"
done

# Upload caption if provided
if [ -n "$CAPTION_FILE" ] && [ -f "$CAPTION_FILE" ]; then
  echo "Uploading caption..."
  gog drive upload "$CAPTION_FILE" --parent "$FOLDER_ID"
fi

echo "✅ All files uploaded to IG素材/$TODAY"
