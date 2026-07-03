# YouTube Music Companion

A browser extension for Firefox and Chrome that lets you control YouTube Music playback from a mini player: song info, play/pause, next/previous, and more.

> ⚠️ Early development — nothing to see here yet.

## Features (planned)

- Mini player popup: album art, playback controls, seek, volume
- Keyboard shortcuts (play/pause, next, previous, like)
- Queue: view, jump, play next, remove, reorder
- Playback history (stored locally)
- Lyrics via [LRCLIB](https://lrclib.net) — better than YTM's own, optionally time-synced
- Search and playlists
- Themes
- Works on both Firefox (MV3 background scripts) and Chrome (MV3 service worker)

See [ROADMAP.md](ROADMAP.md) for build order and decisions.

## Development

There is no build step yet. Load the extension unpacked:

- **Firefox:** `about:debugging` → This Firefox → Load Temporary Add-on
- **Chrome:** `chrome://extensions` → Developer mode → Load unpacked
