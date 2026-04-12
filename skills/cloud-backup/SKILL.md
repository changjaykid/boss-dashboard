---
name: cloud-backup
description: "Automated daily backup of OpenClaw workspace to Google Drive. Backs up identity files, memory, skills, trading configs/logs, social configs, dashboard, scripts, and openclaw config into a single zip. Keeps last 7 backups, auto-deletes older ones. Use when: (1) running daily backup cron (06:00), (2) boss asks to run a manual backup, (3) boss asks about backup status, (4) restoring from backup on a new machine."
---

# Cloud Backup System

## Overview

每天 06:00 自動備份整個 OpenClaw workspace 到 Google Drive，確保換電腦或硬碟壞掉時能完整復原。

## What Gets Backed Up

| Category | Contents |
|----------|----------|
| Core identity | AGENTS.md, SOUL.md, IDENTITY.md, USER.md, MEMORY.md, HEARTBEAT.md, TOOLS.md |
| Memory | memory/*.md (all daily logs) |
| Skills | skills/ (all custom skills, complete) |
| Trading | configs, strategies, trade logs, state files |
| Social | config, publisher, published posts |
| Dashboard | index.html + all JSON data files |
| OpenClaw config | openclaw.json |
| Scripts | scripts/ (backup script itself, utilities) |
| IG carousel | drafts, output, captions |

## Script

`scripts/backup_to_drive.sh` — single script, handles everything:
1. Copies critical files to temp directory
2. Zips into `openclaw-backup-YYYYMMDD.zip`
3. Uploads to Google Drive
4. Cleans up backups older than 7 days
5. Removes temp files

## Google Drive

- Account: socialobservertw@gmail.com
- Folder: AI管家備份
- Folder ID: `1sGIdASzk2-zWl749QU7E8ScECr2N6zK3`
- Retention: Last 7 backups (auto-cleanup)

## Cron

- `daily-backup` — 06:00 Asia/Taipei
- Runs `bash scripts/backup_to_drive.sh`

## Manual Backup

```bash
bash scripts/backup_to_drive.sh
```

## Restore on New Machine

1. Install OpenClaw on new machine
2. Download latest backup zip from Google Drive
3. Unzip to `~/.openclaw/workspace/`
4. Copy `openclaw-config/openclaw.json` to `~/.openclaw/`
5. Re-setup gog OAuth (credentials need re-auth)
6. Re-install Python dependencies (`pip3 install Pillow`)
7. Verify with `openclaw status`
