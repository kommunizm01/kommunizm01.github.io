/* eslint-disable no-console */

const DEFAULT_CONFIG = {
  CAPTURE_INTERVAL_SECONDS: 3,
  WINDOW_HOURS: 72,
  REPLAY_DURATION_SECONDS: 60,
  IDLE_TIMEOUT_SECONDS: 10,
  CAMERA_FACING: "environment",
  CAMERA_DEVICE_ID: "",
  IMAGE_WIDTH: 1280,
  IMAGE_HEIGHT: 720,
  IMAGE_QUALITY: 0.6,
};

const CONFIG_STORAGE_KEY = "aral.timelapse.config.v1";
const MIN_FRAMES_BEFORE_DISPLAY = 10;
const QUOTA_AGGRESSIVE_TRIM_RATIO = 0.9;
const LONG_PRESS_MS = 3000;

let config = loadConfig();

const db = new Dexie("AralTimelapseDB");
db.version(1).stores({
  frames: "ts",
});

const els = {
  video: document.getElementById("camera-video"),
  canvas: document.getElementById("capture-canvas"),
  display: document.getElementById("display-image"),
  status: document.getElementById("status-message"),
  recDot: document.getElementById("rec-dot"),
  playbackIndicator: document.getElementById("playback-indicator"),
  timeline: document.getElementById("timeline"),
  timelineTrack: document.getElementById("timeline-track"),
  timelineFill: document.getElementById("timeline-fill"),
  timelineThumb: document.getElementById("timeline-thumb"),
  timelineLabels: document.getElementById("timeline-labels"),
  longPressZone: document.getElementById("long-press-zone"),
  permissionPrompt: document.getElementById("permission-prompt"),
  permissionMessage: document.getElementById("permission-message"),
  grantCameraBtn: document.getElementById("grant-camera-btn"),
  settingsPanel: document.getElementById("settings-panel"),
  settingInterval: document.getElementById("setting-interval"),
  settingWindow: document.getElementById("setting-window"),
  settingReplay: document.getElementById("setting-replay"),
  settingIdle: document.getElementById("setting-idle"),
  settingCamera: document.getElementById("setting-camera"),
  settingDevice: document.getElementById("setting-device"),
  settingQuality: document.getElementById("setting-quality"),
  statFrames: document.getElementById("stat-frames"),
  statStorage: document.getElementById("stat-storage"),
  statOldest: document.getElementById("stat-oldest"),
  settingsSaveBtn: document.getElementById("settings-save-btn"),
  settingsClearBtn: document.getElementById("settings-clear-btn"),
  settingsCloseBtn: document.getElementById("settings-close-btn"),
  debug: document.getElementById("debug-hud"),
  app: document.getElementById("app"),
};

const state = {
  mode: "live",
  stream: null,
  captureTimer: null,
  wakeLock: null,
  lastFrameTs: null,
  lastDisplayedTs: null,
  frameIndex: [],
  playbackIndex: 0,
  playbackTimer: null,
  idleTimer: null,
  playbackIndicatorTimer: null,
  currentObjectUrl: null,
  longPressTimer: null,
};

function loadConfig() {
  try {
    const raw = localStorage.getItem(CONFIG_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_CONFIG };
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig() {
  localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(config));
}

function windowMs() {
  return config.WINDOW_HOURS * 3600 * 1000;
}

function computeFps() {
  const totalFrames = (config.WINDOW_HOURS * 3600) / config.CAPTURE_INTERVAL_SECONDS;
  return totalFrames / config.REPLAY_DURATION_SECONDS;
}

async function init() {
  registerServiceWorker();
  requestPersistentStorage();

  await refreshFrameIndex();
  updateStatusForFrameCount();
  if (state.frameIndex.length >= MIN_FRAMES_BEFORE_DISPLAY) {
    await showFrameByTs(state.frameIndex[state.frameIndex.length - 1]);
  }

  applyModeClass();
  renderTimelineLabels();

  bindUi();
  acquireWakeLock();
  setupVisibilityHandlers();

  await startCamera();
  scheduleNextCapture(0);
  resetIdleTimer();
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("service-worker.js").catch((err) => {
    console.warn("SW registration failed", err);
  });
}

async function requestPersistentStorage() {
  if (!navigator.storage || !navigator.storage.persist) return;
  try {
    const granted = await navigator.storage.persist();
    console.log("Persistent storage:", granted);
  } catch (err) {
    console.warn("persist() failed", err);
  }
}

async function acquireWakeLock() {
  if (!("wakeLock" in navigator)) {
    console.warn("Wake Lock API not supported");
    return;
  }
  try {
    state.wakeLock = await navigator.wakeLock.request("screen");
    state.wakeLock.addEventListener("release", () => {
      state.wakeLock = null;
    });
  } catch (err) {
    console.warn("Wake Lock request failed", err);
  }
}

function setupVisibilityHandlers() {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      acquireWakeLock();
      if (!state.stream) startCamera();
    }
  });
}

async function startCamera() {
  if (state.stream) {
    state.stream.getTracks().forEach((t) => t.stop());
    state.stream = null;
  }

  const videoConstraints = {
    width: { ideal: config.IMAGE_WIDTH },
    height: { ideal: config.IMAGE_HEIGHT },
    frameRate: { ideal: 30, max: 30 },
  };
  if (config.CAMERA_DEVICE_ID) {
    videoConstraints.deviceId = { exact: config.CAMERA_DEVICE_ID };
  } else {
    videoConstraints.facingMode = { ideal: config.CAMERA_FACING };
  }
  const constraints = { audio: false, video: videoConstraints };

  try {
    state.stream = await navigator.mediaDevices.getUserMedia(constraints);
    els.video.srcObject = state.stream;
    await new Promise((resolve) => {
      if (els.video.readyState >= 2) return resolve();
      els.video.onloadedmetadata = () => resolve();
    });
    els.permissionPrompt.classList.add("hidden");
  } catch (err) {
    console.error("Camera access failed", err);
    showPermissionPrompt(err);
  }
}

function showPermissionPrompt(err) {
  els.permissionPrompt.classList.remove("hidden");
  if (err && err.name === "NotAllowedError") {
    els.permissionMessage.textContent =
      "Camera access was denied. Tap to retry, then allow the camera in the browser prompt.";
  } else if (err && err.name === "NotFoundError") {
    els.permissionMessage.textContent = "No camera found on this device.";
  } else {
    els.permissionMessage.textContent = "The camera could not be started. Tap to retry.";
  }
}

function scheduleNextCapture(delayMs) {
  clearTimeout(state.captureTimer);
  const wait = delayMs != null ? delayMs : config.CAPTURE_INTERVAL_SECONDS * 1000;
  state.captureTimer = setTimeout(captureLoop, wait);
}

async function captureLoop() {
  try {
    await captureFrame();
  } catch (err) {
    console.error("Capture failed", err);
  } finally {
    scheduleNextCapture();
  }
}

async function captureFrame() {
  if (!state.stream || !els.video.videoWidth) return;

  const canvas = els.canvas;
  canvas.width = config.IMAGE_WIDTH;
  canvas.height = config.IMAGE_HEIGHT;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(els.video, 0, 0, canvas.width, canvas.height);

  const blob = await new Promise((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", config.IMAGE_QUALITY)
  );
  if (!blob) return;

  const ts = Date.now();

  flashRecDot();

  try {
    await db.frames.put({ ts, blob });
  } catch (err) {
    if (isQuotaError(err)) {
      await aggressiveTrim();
      try {
        await db.frames.put({ ts, blob });
      } catch (err2) {
        console.error("Quota persists after trim", err2);
        return;
      }
    } else {
      throw err;
    }
  }

  state.lastFrameTs = ts;
  state.frameIndex.push(ts);
  console.log(`[capture] #${state.frameIndex.length} blob=${blob.size}B ts=${ts}`);

  await trimOldFrames();
  updateStatusForFrameCount();
  renderTimelineLabels();
  updateDebug();

  if (state.mode === "live") {
    updateTimelineThumb(1);
  }
}

function isQuotaError(err) {
  if (!err) return false;
  return (
    err.name === "QuotaExceededError" ||
    err.inner?.name === "QuotaExceededError" ||
    /quota/i.test(err.message || "")
  );
}

async function trimOldFrames() {
  const cutoff = Date.now() - windowMs();
  const oldKeys = await db.frames.where("ts").below(cutoff).primaryKeys();
  if (oldKeys.length > 0) {
    await db.frames.bulkDelete(oldKeys);
    state.frameIndex = state.frameIndex.filter((ts) => ts >= cutoff);
  }
}

async function aggressiveTrim() {
  await refreshFrameIndex();
  const total = state.frameIndex.length;
  if (total === 0) return;
  const keepCount = Math.floor(total * QUOTA_AGGRESSIVE_TRIM_RATIO);
  const dropCount = total - keepCount;
  if (dropCount <= 0) return;
  const toDelete = state.frameIndex.slice(0, dropCount);
  await db.frames.bulkDelete(toDelete);
  state.frameIndex = state.frameIndex.slice(dropCount);
  console.warn(`Quota: aggressively trimmed ${dropCount} frames`);
}

async function refreshFrameIndex() {
  state.frameIndex = await db.frames.orderBy("ts").primaryKeys();
}

function updateStatusForFrameCount() {
  const count = state.frameIndex.length;
  if (count < MIN_FRAMES_BEFORE_DISPLAY) {
    els.status.classList.remove("hidden");
    els.status.textContent = `Capturing first frames… (${count}/${MIN_FRAMES_BEFORE_DISPLAY})`;
  } else {
    els.status.classList.add("hidden");
  }
}

function flashRecDot() {
  els.recDot.classList.remove("active");
  void els.recDot.offsetWidth;
  els.recDot.classList.add("active");
  setTimeout(() => els.recDot.classList.remove("active"), 1200);
}

async function showFrameByTs(ts) {
  if (state.lastDisplayedTs === ts) return;
  const frame = await db.frames.get(ts);
  if (!frame || !frame.blob) {
    console.warn("showFrameByTs: no frame for ts", ts);
    return;
  }

  const url = URL.createObjectURL(frame.blob);
  const previousUrl = state.currentObjectUrl;

  try {
    if (els.display.decode) {
      els.display.src = url;
      await els.display.decode().catch(() => {});
    } else {
      await new Promise((resolve, reject) => {
        const tmp = new Image();
        tmp.onload = resolve;
        tmp.onerror = reject;
        tmp.src = url;
      }).catch(() => {});
      els.display.src = url;
    }
  } catch (err) {
    console.warn("Image decode failed", err);
    URL.revokeObjectURL(url);
    return;
  }

  state.currentObjectUrl = url;
  state.lastDisplayedTs = ts;
  if (previousUrl && previousUrl !== url) {
    URL.revokeObjectURL(previousUrl);
  }
  updateDebug();
}

function updateDebug() {
  if (!els.debug) return;
  const last = state.lastFrameTs ? new Date(state.lastFrameTs).toLocaleTimeString() : "—";
  const shown = state.lastDisplayedTs ? new Date(state.lastDisplayedTs).toLocaleTimeString() : "—";
  els.debug.textContent = `frames ${state.frameIndex.length} • mode ${state.mode} • last cap ${last} • shown ${shown}`;
}

function nearestFrameTsForFraction(fraction) {
  if (state.frameIndex.length === 0) return null;
  const idx = Math.round(fraction * (state.frameIndex.length - 1));
  return state.frameIndex[Math.max(0, Math.min(state.frameIndex.length - 1, idx))];
}

function updateTimelineThumb(fraction) {
  const clamped = Math.max(0, Math.min(1, fraction));
  els.timelineThumb.style.left = `${clamped * 100}%`;
  els.timelineFill.style.width = `${clamped * 100}%`;
}

function formatAgo(ms) {
  if (ms < 1000) return "now";
  const s = Math.round(ms / 1000);
  if (s < 60) return `-${s}s`;
  const totalMin = Math.round(s / 60);
  if (totalMin < 60) return `-${totalMin}min`;
  // ≥ 1h: round to nearest 5 minutes, show as H or H:MMh
  const rounded5 = Math.round(totalMin / 5) * 5;
  const h = Math.floor(rounded5 / 60);
  const m = rounded5 % 60;
  if (m === 0) return `-${h}h`;
  return `-${h}:${String(m).padStart(2, "0")}h`;
}

function renderTimelineLabels() {
  const el = els.timelineLabels;
  if (!el) return;
  const n = state.frameIndex.length;
  if (n === 0) {
    el.innerHTML = '<span>—</span><button type="button" class="tl-live" data-action="live">live</button>';
    return;
  }
  const oldest = state.frameIndex[0];
  const spanMs = Math.max(1000, Date.now() - oldest);
  const fractions = [0, 0.25, 0.5, 0.75];
  const parts = fractions.map((f) => {
    const ago = spanMs * (1 - f);
    return `<span>${formatAgo(ago)}</span>`;
  });
  parts.push('<button type="button" class="tl-live" data-action="live">live</button>');
  el.innerHTML = parts.join("");
}

function bindUi() {
  bindTimeline();
  bindLongPress();
  bindSettings();
  bindPermission();
  bindLiveLabel();
  bindKeyboard();

  document.addEventListener("touchstart", onAnyTouch, { passive: true });
  document.addEventListener("mousedown", onAnyTouch);
}

function bindKeyboard() {
  document.addEventListener("keydown", (e) => {
    const tag = (e.target && e.target.tagName) || "";
    const inField = tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA";
    const settingsOpen = !els.settingsPanel.classList.contains("hidden");

    // Esc: close any overlay
    if (e.key === "Escape") {
      if (settingsOpen) {
        e.preventDefault();
        closeSettings();
      }
      return;
    }

    // ignore other shortcuts while typing in settings inputs
    if (inField) return;

    // s → open settings
    if ((e.key === "s" || e.key === "S") && !settingsOpen && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      openSettings();
      return;
    }

    // l → live mode
    if ((e.key === "l" || e.key === "L") && !settingsOpen) {
      e.preventDefault();
      enterLiveMode();
      resetIdleTimer();
      return;
    }
  });
}

function bindLiveLabel() {
  const handler = (e) => {
    const target = e.target.closest('[data-action="live"]');
    if (!target) return;
    e.preventDefault();
    e.stopPropagation();
    console.log("[live] tap → enterLiveMode");
    enterLiveMode();
    resetIdleTimer();
  };
  els.timelineLabels.addEventListener("click", handler);
  els.timelineLabels.addEventListener("pointerdown", handler);
}

function bindTimeline() {
  let dragging = false;
  const track = els.timelineTrack;

  const pointerToFraction = (clientX) => {
    const rect = track.getBoundingClientRect();
    const x = clientX - rect.left;
    return Math.max(0, Math.min(1, x / rect.width));
  };

  const startScrub = (clientX) => {
    if (state.frameIndex.length === 0) return;
    dragging = true;
    track.classList.add("dragging");
    enterScrubMode();
    handleScrubMove(clientX);
  };

  const handleScrubMove = (clientX) => {
    const fraction = pointerToFraction(clientX);
    updateTimelineThumb(fraction);
    const ts = nearestFrameTsForFraction(fraction);
    if (ts != null) showFrameByTs(ts);
  };

  const endScrub = (clientX) => {
    if (!dragging) return;
    dragging = false;
    track.classList.remove("dragging");
    const fraction = pointerToFraction(clientX);
    if (fraction >= 0.98) {
      enterLiveMode();
    }
    resetIdleTimer();
  };

  track.addEventListener("touchstart", (e) => {
    e.preventDefault();
    startScrub(e.touches[0].clientX);
  }, { passive: false });

  track.addEventListener("touchmove", (e) => {
    if (!dragging) return;
    e.preventDefault();
    handleScrubMove(e.touches[0].clientX);
  }, { passive: false });

  track.addEventListener("touchend", (e) => {
    const x = e.changedTouches[0]?.clientX ?? 0;
    endScrub(x);
  });

  track.addEventListener("mousedown", (e) => {
    startScrub(e.clientX);
  });
  document.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    handleScrubMove(e.clientX);
  });
  document.addEventListener("mouseup", (e) => endScrub(e.clientX));
}

function bindLongPress() {
  const zone = els.longPressZone;
  const start = () => {
    clearTimeout(state.longPressTimer);
    state.longPressTimer = setTimeout(openSettings, LONG_PRESS_MS);
  };
  const cancel = () => clearTimeout(state.longPressTimer);

  zone.addEventListener("touchstart", start, { passive: true });
  zone.addEventListener("touchend", cancel);
  zone.addEventListener("touchcancel", cancel);
  zone.addEventListener("touchmove", cancel);
  zone.addEventListener("mousedown", start);
  zone.addEventListener("mouseup", cancel);
  zone.addEventListener("mouseleave", cancel);
}

function bindSettings() {
  els.settingsCloseBtn.addEventListener("click", closeSettings);
  els.settingsSaveBtn.addEventListener("click", saveSettings);
  els.settingsClearBtn.addEventListener("click", clearAllFrames);
}

function bindPermission() {
  els.grantCameraBtn.addEventListener("click", async () => {
    await startCamera();
    if (state.stream) {
      scheduleNextCapture(0);
    }
  });
}

function onAnyTouch(e) {
  if (!els.settingsPanel.classList.contains("hidden")) return;
  if (e.target.closest("#timeline")) return;
  if (state.mode === "idle-playback") {
    stopIdlePlayback();
    enterScrubMode();
  }
  resetIdleTimer();
}

function applyModeClass() {
  if (!els.app) return;
  els.app.classList.toggle("mode-live", state.mode === "live");
  els.app.classList.toggle("mode-scrubbed", state.mode === "scrubbed");
  els.app.classList.toggle("mode-idle-playback", state.mode === "idle-playback");
  updateDebug();
}

function enterLiveMode() {
  state.mode = "live";
  stopIdlePlayback();
  applyModeClass();
  updateTimelineThumb(1);
}

function enterScrubMode() {
  state.mode = "scrubbed";
  stopIdlePlayback();
  applyModeClass();
}

function resetIdleTimer() {
  clearTimeout(state.idleTimer);
  state.idleTimer = setTimeout(startIdlePlayback, config.IDLE_TIMEOUT_SECONDS * 1000);
}

function startIdlePlayback() {
  if (state.frameIndex.length < MIN_FRAMES_BEFORE_DISPLAY) {
    resetIdleTimer();
    return;
  }
  state.mode = "idle-playback";
  state.playbackIndex = 0;
  applyModeClass();

  showPlaybackIndicator();

  const fps = computeFps();
  const intervalMs = Math.max(16, 1000 / fps);

  clearInterval(state.playbackTimer);
  state.playbackTimer = setInterval(() => {
    if (state.frameIndex.length === 0) return;
    if (state.playbackIndex >= state.frameIndex.length) {
      state.playbackIndex = 0;
    }
    const ts = state.frameIndex[state.playbackIndex];
    showFrameByTs(ts);
    updateTimelineThumb(state.playbackIndex / Math.max(1, state.frameIndex.length - 1));
    state.playbackIndex += 1;
  }, intervalMs);
}

function stopIdlePlayback() {
  clearInterval(state.playbackTimer);
  state.playbackTimer = null;
  hidePlaybackIndicator();
}

function showPlaybackIndicator() {
  els.playbackIndicator.classList.add("visible");
  clearTimeout(state.playbackIndicatorTimer);
  state.playbackIndicatorTimer = setTimeout(() => {
    els.playbackIndicator.classList.remove("visible");
  }, 3500);
}

function hidePlaybackIndicator() {
  els.playbackIndicator.classList.remove("visible");
  clearTimeout(state.playbackIndicatorTimer);
}

async function openSettings() {
  els.settingInterval.value = config.CAPTURE_INTERVAL_SECONDS;
  els.settingWindow.value = config.WINDOW_HOURS;
  els.settingReplay.value = config.REPLAY_DURATION_SECONDS;
  els.settingIdle.value = config.IDLE_TIMEOUT_SECONDS;
  els.settingCamera.value = config.CAMERA_FACING;
  els.settingQuality.value = config.IMAGE_QUALITY;

  await populateDeviceList();
  await updateSettingsStats();
  els.settingsPanel.classList.remove("hidden");
  clearTimeout(state.idleTimer);
}

async function populateDeviceList() {
  const sel = els.settingDevice;
  if (!sel || !navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cams = devices.filter((d) => d.kind === "videoinput");
    sel.innerHTML = '<option value="">Auto (use facing)</option>';
    cams.forEach((d, i) => {
      const opt = document.createElement("option");
      opt.value = d.deviceId;
      opt.textContent = d.label || `Camera ${i + 1}`;
      sel.appendChild(opt);
    });
    sel.value = config.CAMERA_DEVICE_ID || "";
  } catch (err) {
    console.warn("enumerateDevices failed", err);
  }
}

function closeSettings() {
  els.settingsPanel.classList.add("hidden");
  resetIdleTimer();
}

async function updateSettingsStats() {
  const count = state.frameIndex.length;
  els.statFrames.textContent = String(count);

  if (navigator.storage && navigator.storage.estimate) {
    try {
      const est = await navigator.storage.estimate();
      const usedMb = (est.usage || 0) / (1024 * 1024);
      const quotaMb = (est.quota || 0) / (1024 * 1024);
      els.statStorage.textContent = `${usedMb.toFixed(1)} MB / ${quotaMb.toFixed(0)} MB`;
    } catch {
      els.statStorage.textContent = "—";
    }
  }

  if (count > 0) {
    const oldest = new Date(state.frameIndex[0]);
    els.statOldest.textContent = oldest.toLocaleString();
  } else {
    els.statOldest.textContent = "—";
  }
}

async function saveSettings() {
  const newInterval = Number(els.settingInterval.value);
  const newWindow = Number(els.settingWindow.value);
  const newReplay = Number(els.settingReplay.value);
  const newIdle = Number(els.settingIdle.value);
  const newCamera = els.settingCamera.value;
  const newDevice = els.settingDevice ? els.settingDevice.value : "";
  const newQuality = Number(els.settingQuality.value);

  if (!Number.isFinite(newInterval) || newInterval < 5) return alert("Interval must be ≥ 5s");
  if (!Number.isFinite(newWindow) || newWindow < 1) return alert("Window must be ≥ 1h");
  if (!Number.isFinite(newReplay) || newReplay < 5) return alert("Replay must be ≥ 5s");
  if (!Number.isFinite(newIdle) || newIdle < 5) return alert("Idle timeout must be ≥ 5s");
  if (!Number.isFinite(newQuality) || newQuality < 0.1 || newQuality > 1) return alert("Quality 0.1-1.0");

  const cameraChanged = newCamera !== config.CAMERA_FACING || newDevice !== config.CAMERA_DEVICE_ID;

  config.CAPTURE_INTERVAL_SECONDS = newInterval;
  config.WINDOW_HOURS = newWindow;
  config.REPLAY_DURATION_SECONDS = newReplay;
  config.IDLE_TIMEOUT_SECONDS = newIdle;
  config.CAMERA_FACING = newCamera;
  config.CAMERA_DEVICE_ID = newDevice;
  config.IMAGE_QUALITY = newQuality;
  saveConfig();

  await trimOldFrames();

  if (cameraChanged) {
    await startCamera();
  }

  scheduleNextCapture(0);
  closeSettings();
}

async function clearAllFrames() {
  if (!confirm("Delete all stored frames? This cannot be undone.")) return;
  await db.frames.clear();
  state.frameIndex = [];
  state.lastDisplayedTs = null;
  state.lastFrameTs = null;
  els.display.removeAttribute("src");
  if (state.currentObjectUrl) {
    URL.revokeObjectURL(state.currentObjectUrl);
    state.currentObjectUrl = null;
  }
  updateStatusForFrameCount();
  await updateSettingsStats();
  renderTimelineLabels();
  updateTimelineThumb(1);
}

init().catch((err) => {
  console.error("Init failed", err);
  els.status.textContent = "Startup error — check console";
  els.status.classList.remove("hidden");
});
