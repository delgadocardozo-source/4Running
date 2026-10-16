# PACE/01 — v1.4.0

A lightweight, mobile-first PWA for interval-based beginner running training.

## Product goal
Answer one question clearly: **What do I need to do today, and how am I progressing?**

Operating model: **plan base + user data + safety rules → confirm next session** (see `PRODUCT.md`).

## v1 features
- Light, minimal UI optimized for iPhone.
- Interval workout engine with warm-up, work, recovery and cool-down blocks.
- Timestamp-based timer with catch-up after backgrounding.
- Audio cues, spoken Spanish instructions and 5-second countdown.
- Per-session treadmill speed guidance and estimated distance (speeds editable mid-session without reset).
- Pause, skip, previous block, +30 second and reset controls.
- Best-effort Screen Wake Lock support.
- Local session history (localStorage): distance, time, continuous minutes, RPE, pain and notes.
- Home metrics derived from stored sessions.
- JSON export of history + settings.
- Seeded first-week data based on the current training conversation.
- 2K vs 5K decision criteria and race countdown to 2026-11-01.
- PWA manifest (PNG + SVG icons) + service worker for install/offline shell.

## Current planned workout
Week 2 · Session 1:
- Warm-up 5:00 @ 5.0 km/h
- Run 2:00 @ 7.5 km/h
- Walk 2:00 @ 5.0 km/h
- Repeat run/walk x7
- Cool-down 5:00 @ 4.5 km/h

## Technical notes
- Static frontend: HTML/CSS/vanilla JS. No framework dependency for v1.
- Data persists only on the current browser/device using localStorage.
- No backend or authentication yet.
- Paths are relative so the app can be served from `/` or `/pacelab-v1/`.
- The app does not claim to replace medical advice or a coach.
- iOS/PWA limitation: interval alerts cannot be guaranteed if iOS suspends the PWA while the screen is locked. The workout view therefore includes audio/voice cues and best-effort Screen Wake Lock.

## Suggested v2
- Vercel Postgres/Blob or Supabase for account sync.
- OAuth with Strava and automatic workout import.
- Workout plan editor with versioned schema.
- Adaptive progression engine based on RPE, pain, continuous run time and completion rate.
- Race predictor using actual continuous-run data.
- CSV export.
- Native iOS companion if fully reliable background interval alerts and HealthKit are required.

## Run locally
Serve the folder with any static server, e.g.:

```bash
cd pacelab-v1
python3 -m http.server 4173
```

Then open `http://localhost:4173`.
