# TOOLS.md - Local Notes

Skills define _how_ tools work. This file is for _your_ specifics — the stuff that's unique to your setup.

## What Goes Here

Things like:

- Camera names and locations
- SSH hosts and aliases
- Preferred voices for TTS
- Speaker/room names
- Device nicknames
- Anything environment-specific

## Examples

```markdown
### Cameras

- living-room → Main area, 180° wide angle
- front-door → Entrance, motion-triggered

### SSH

- home-server → 192.168.1.100, user: admin

### TTS

- Preferred voice: "Nova" (warm, slightly British)
- Default speaker: Kitchen HomePod
```

## Why Separate?

Skills are shared. Your setup is yours. Keeping them apart means you can update skills without losing your notes, and share skills without leaking your infrastructure.

---

Add whatever helps you do your job. This is your cheat sheet.

### 主控板部署
- **Repo**: changjaykid/boss-dashboard (branch: main)
- **部署方式**: GitHub Pages（自動，push 到 main 就會重建）
- **線上網址**: https://changjaykid.github.io/boss-dashboard/
- **本地檔案**: boss-dashboard/index.html
- **同步副本**: boss-dashboard-cloudflare/index.html（需手動同步）
- **密碼**: 8888
- **注意**: 修改後要 git push origin main，不是 master
