# Aral Soap Timelapse

A single-page kiosk PWA that turns a Samsung Galaxy Tab into a self-contained
timelapse camera + playback display. The tablet captures a still image every
N seconds, keeps a rolling 72-hour window in IndexedDB, lets visitors scrub
the timeline by touch, and after idle auto-plays the last 72 hours compressed
into a 60-second loop. No backend, no cloud — frames never leave the device.

---

## Files

```
aral_soap_timelapse/
├── index.html
├── main.js
├── style.css
├── manifest.json
├── service-worker.js
├── icon.png
└── README.md
```

---

## 1. Deploy to GitHub Pages

GitHub Pages serves over HTTPS, which is mandatory — the camera API refuses
to start on plain HTTP except on `localhost`.

1. Create a new public repo, e.g. `aral-soap-timelapse`.
2. Copy every file from this folder into the repo root.
3. Commit and push to `main`.
4. In the repo on GitHub: **Settings → Pages → Build and deployment**.
   - Source: **Deploy from a branch**
   - Branch: **main**, folder: **/ (root)**
5. Wait a minute. The app appears at
   `https://<your-username>.github.io/aral-soap-timelapse/`.

If you prefer a custom subpath or a `docs/` folder, adjust paths in
`manifest.json` accordingly (the `start_url` and `scope` are relative, so a
subpath should "just work").

---

## 2. Install as a PWA on the Galaxy Tab

1. Open Chrome on the tablet.
2. Navigate to the GitHub Pages URL.
3. The first load asks for **camera permission** — tap **Allow**.
4. Chrome menu (⋮) → **Add to Home screen** (or "Install app").
5. Confirm. An icon appears on the home screen.
6. Launch from the home screen icon — it opens fullscreen, no browser chrome.

> If "Add to Home screen" does not show "Install", make sure the page is
> being served over HTTPS and the service worker has finished registering
> (reload once).

---

## 3. First-load permissions

The app requests three things on first load:

| Permission | What for | If denied |
|---|---|---|
| **Camera** | Capturing frames | The permission overlay reappears with a retry button. |
| **Wake Lock** | Keeping the screen on while the app is foregrounded | App still captures, but the tablet's normal screen timeout takes over — see Kiosk tips below. |
| **Persistent storage** | Asking the browser not to evict IndexedDB under pressure | App still works; under heavy device storage pressure the browser may eventually evict old frames. |

The Wake Lock is re-acquired whenever the app becomes visible again
(switching tabs, unlocking the device, etc.).

---

## 4. The hidden settings panel

There is **no visible settings button** — visitors cannot reach it by
accident.

- **Long-press the bottom-left corner of the screen for 3 seconds.**
- The settings panel opens. Adjustable values:
  - Capture interval (seconds)
  - Window (hours)
  - Replay duration (seconds)
  - Idle timeout (seconds)
  - Camera (rear / front)
  - Image quality (0.1 – 1.0)
- It also shows live stats: frames stored, storage used / quota, oldest frame
  timestamp.
- **Save & restart capture** persists the config to `localStorage` and
  restarts the capture loop immediately.
- **Clear all frames** wipes IndexedDB (asks for confirmation).
- **Close** dismisses the panel.

Config defaults live at the top of `main.js` (`DEFAULT_CONFIG`). Any saved
overrides take precedence on subsequent loads.

---

## 5. Kiosk-mode tips for the Galaxy Tab

For an unattended exhibition tablet, you want a setup that survives accidental
taps, sleep, and reboots.

1. **Plug the tablet into a charger continuously.** Capturing every couple of
   minutes and keeping the screen on will drain a battery in roughly 6–10 h.
2. **Disable screen timeout:**
   *Settings → Display → Screen timeout → Never* (or the longest available).
   The Wake Lock should keep the screen on anyway, but this is a safety net.
3. **Disable auto-rotate** and lock to landscape — the manifest already
   requests landscape, but the OS lock prevents weird rotations when someone
   picks the tablet up.
4. **Pin the Chrome tab** so a visitor can't navigate away:
   - Samsung One UI has a feature called **Screen Pinning**
     (*Settings → Biometrics and security → Other security settings → Pin
     windows*). Enable it, then in the Recents view tap the Chrome icon and
     choose "Pin this app". Unpinning requires the PIN.
   - Or use **Samsung Kiosk Mode** / **Knox Configure** if you have a
     business setup.
5. **Turn off notifications** so a banner doesn't cover the image.
6. **Hide the navigation bar** (One UI: full-screen gestures) for a cleaner
   look.
7. After install, launch via the **home-screen icon**, not from inside
   Chrome — that gives you the standalone PWA window without an address bar.
8. If the tablet reboots, you'll need someone to tap the home-screen icon
   once. (A scheduled boot script is out of scope for a pure web app.)

---

## 6. Edge cases the app handles

- **Empty IndexedDB on first load:** shows *"Capturing first frames…
  (N/10)"* until at least 10 frames exist, then begins displaying live.
- **Reload / browser crash mid-capture:** all already-stored frames persist;
  the app reads the index and resumes capturing on next load.
- **Tablet power-cycle:** IndexedDB survives; same as above.
- **Quota approached:** if a `QuotaExceededError` fires while writing, the
  app trims to 90 % of current frame count and retries the write.
- **Camera permission denied:** an overlay appears with a *Grant camera
  access* button that re-requests permission.
- **Wake Lock unsupported / fails:** logged to console; capture still runs.
  The OS-level screen timeout becomes the only thing keeping the display on,
  so set it to *Never* on the tablet (see Kiosk tips).

---

## 7. Sanity-checking storage usage

At default settings:

- 144-second interval × 72 hours = **1,800 frames**
- ~30–50 KB per JPEG @ 1280×720, quality 0.6 → **~55–90 MB** at steady
  state.

Chrome on Android typically grants several hundred MB to multiple GB of
quota per origin. Open the settings panel to see actual reported quota and
usage.

---

## 8. Local development

Because the camera API requires a secure context, you have two options:

```bash
# A) Just open via localhost
npx serve aral_soap_timelapse
# then visit http://localhost:3000

# B) Use any other static server you like; localhost is treated as secure.
```

For testing on a real tablet from your laptop, the easiest path is to push
to GitHub and reload the Pages URL on the tablet. `localhost` over USB
forwarding also works if you wire that up.

---

## 9. What this app deliberately is NOT

- Not multi-device — one tablet captures and plays back; nothing syncs.
- No cloud uploads — frames stay on the tablet.
- No video file output — frames remain discrete JPEGs in IndexedDB. (A
  client-side encoder could be bolted on later if you ever need a shareable
  72-hour MP4.)
