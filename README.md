# 🏆 Anime Bracket

A local, single-device tournament manager for anime. Build a roster from
MyAnimeList data, generate a single-elimination bracket, and vote each matchup
until a champion is crowned.

## Features

- **Search & add** competitors via the [Jikan API](https://jikan.moe) (free, no key)
  — pulls each anime's poster + synopsis.
- **Dynamic brackets** — any number of competitors (≥2). Non-power-of-2 counts
  get seeded **byes** so top seeds auto-advance round 1.
- **Two views** — a full bracket tree (overview) and a focused voting screen.
- **Group voting** — tap +/− on either fighter; the most-voted advances. Ties
  prompt for a tie-breaker vote.
- **Auto-save** — progress persists in `localStorage`, so a refresh won't lose
  the tournament. **Reset** clears everything.

## Run it

No build step. Either:

- **Double-click `index.html`** — opens straight in your browser, or
- Serve the folder (needed only if your browser blocks `file://` fetches):

  ```sh
  python -m http.server 5180
  # then open http://localhost:5180
  ```

## Files

| File         | Purpose                                            |
|--------------|----------------------------------------------------|
| `index.html` | Markup + view containers                           |
| `style.css`  | Styling (dark theme)                               |
| `app.js`     | State, Jikan integration, bracket engine, rendering|

## Notes

- Jikan is rate-limited (~3 req/sec); searches are debounced and throttled.
- Data source can be swapped to the official MyAnimeList API later if you need
  account features (e.g. importing a user's personal list) — that requires
  OAuth registration.
