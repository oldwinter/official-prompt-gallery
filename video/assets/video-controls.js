const DRIFT_THRESHOLD_SECONDS = 0.08;
const MAX_DRIFT_CORRECTION_SECONDS = 0.35;
const DEFAULT_DURATION_SECONDS = 5;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function finiteDuration(player) {
  return Number.isFinite(player.duration) && player.duration > 0 ? player.duration : 0;
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const whole = Math.floor(seconds);
  const minutes = Math.floor(whole / 60);
  const remainder = String(whole % 60).padStart(2, "0");
  return `${minutes}:${remainder}`;
}

function setStatus(status, message, kind = "idle") {
  if (!status) return;
  status.textContent = message;
  status.dataset.statusKind = kind;
}

function getRatio(player) {
  const duration = finiteDuration(player);
  if (!duration) return 0;
  return clamp(player.currentTime / duration, 0, 1);
}

function setPlayerRatio(player, ratio) {
  const duration = finiteDuration(player);
  if (!duration) return;
  player.currentTime = clamp(ratio, 0, 1) * duration;
}

/**
 * Add linked controls to one pair of native video players. The first player
 * is the clock; correction is deliberately bounded because the two routes
 * can expose different durations and frame rates.
 */
export function attachVideoComparison(root) {
  if (!root || root.dataset.videoControlsAttached === "true") return null;

  const players = [...root.querySelectorAll("[data-video-player]")].slice(0, 2);
  if (players.length === 0) return null;

  root.dataset.videoControlsAttached = "true";
  const status = root.querySelector("[data-video-status]");
  const seek = root.querySelector("[data-video-seek]");
  const timeReadout = root.querySelector("[data-video-time]");
  const linkToggle = root.querySelector("[data-video-link]");
  const muteButton = root.querySelector('[data-video-action="mute"]');
  let linked = linkToggle ? linkToggle.checked : true;
  let destroyed = false;
  let syncing = false;
  let frameRequest = 0;

  const updateReadout = () => {
    const primary = players[0];
    const duration = finiteDuration(primary) || DEFAULT_DURATION_SECONDS;
    const ratio = getRatio(primary);
    if (seek && document.activeElement !== seek) {
      seek.value = String(Math.round(ratio * Number(seek.max || 1000)));
    }
    if (seek) {
      seek.setAttribute("aria-valuetext", `${formatTime(primary.currentTime)} of ${formatTime(duration)}`);
      seek.setAttribute("aria-label", `Linked timeline, ${Math.round(ratio * 100)} percent`);
    }
    if (timeReadout) timeReadout.value = `${formatTime(primary.currentTime)} / ${formatTime(duration)}`;
    if (timeReadout) timeReadout.textContent = `${formatTime(primary.currentTime)} / ${formatTime(duration)}`;
  };

  const stopFrameLoop = () => {
    if (frameRequest && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(frameRequest);
    }
    frameRequest = 0;
  };

  const correctDrift = () => {
    frameRequest = 0;
    if (destroyed || !linked || players.length < 2 || players[0].paused) return;
    const master = players[0];
    const masterRatio = getRatio(master);
    if (finiteDuration(master) > 0) {
      players.slice(1).forEach((player) => {
        const duration = finiteDuration(player);
        if (!duration) return;
        const desired = masterRatio * duration;
        const delta = desired - player.currentTime;
        if (Math.abs(delta) > DRIFT_THRESHOLD_SECONDS) {
          const correction = clamp(delta, -MAX_DRIFT_CORRECTION_SECONDS, MAX_DRIFT_CORRECTION_SECONDS);
          player.currentTime = clamp(player.currentTime + correction, 0, duration);
        }
      });
    }
    updateReadout();
    if (!players[0].paused && typeof requestAnimationFrame === "function") {
      frameRequest = requestAnimationFrame(correctDrift);
    }
  };

  const startFrameLoop = () => {
    if (!frameRequest && typeof requestAnimationFrame === "function") {
      frameRequest = requestAnimationFrame(correctDrift);
    }
  };

  const pausePlayers = () => {
    players.forEach((player) => {
      if (!player.paused) player.pause();
    });
    stopFrameLoop();
  };

  const seekPlayers = (ratio) => {
    syncing = true;
    players.forEach((player) => setPlayerRatio(player, ratio));
    syncing = false;
    updateReadout();
  };

  const playPlayers = async () => {
    syncing = true;
    const outcomes = await Promise.allSettled(players.map((player) => player.play()));
    syncing = false;
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    if (rejected) {
      pausePlayers();
      setStatus(status, "Playback could not start; use each native player to inspect its state.", "error");
      return false;
    }
    setStatus(status, linked ? "Linked playback active." : "Playback active; players are independent.", "active");
    startFrameLoop();
    return true;
  };

  const restartPlayers = () => {
    seekPlayers(0);
    pausePlayers();
    setStatus(status, "Both players reset to the beginning.", "idle");
  };

  const toggleMute = () => {
    const nextMuted = !players.every((player) => player.muted);
    players.forEach((player) => {
      player.muted = nextMuted;
    });
    if (muteButton) {
      muteButton.textContent = nextMuted ? "Unmute" : "Mute";
      muteButton.setAttribute("aria-pressed", String(nextMuted));
    }
    setStatus(status, nextMuted ? "Both players muted." : "Both players unmuted.", "idle");
  };

  const onNativePlay = (event) => {
    if (syncing || !linked) {
      startFrameLoop();
      return;
    }
    const source = event.currentTarget;
    const ratio = getRatio(source);
    syncing = true;
    players.forEach((player) => {
      if (player !== source) {
        setPlayerRatio(player, ratio);
        void player.play().catch(() => undefined);
      }
    });
    syncing = false;
    setStatus(status, "Linked playback active.", "active");
    startFrameLoop();
  };

  const onNativePause = (event) => {
    if (syncing || !linked) return;
    const source = event.currentTarget;
    syncing = true;
    players.forEach((player) => {
      if (player !== source) player.pause();
    });
    syncing = false;
    stopFrameLoop();
    setStatus(status, "Linked playback paused.", "idle");
  };

  const onNativeSeeking = (event) => {
    if (syncing || !linked) return;
    const ratio = getRatio(event.currentTarget);
    seekPlayers(ratio);
  };

  const onWaiting = (event) => {
    pausePlayers();
    const label = event.currentTarget.dataset.provider || "A player";
    setStatus(status, `${label} is buffering; linked playback paused.`, "active");
  };

  const onCanPlay = () => {
    if (players.some((player) => !player.paused)) {
      setStatus(status, linked ? "Linked playback active." : "Playback active; players are independent.", "active");
      startFrameLoop();
    }
  };

  const onMediaError = (event) => {
    pausePlayers();
    const label = event.currentTarget.dataset.provider || "A player";
    setStatus(status, `${label} reported a media error.`, "error");
  };

  const onEnded = () => {
    if (players.every((player) => player.ended || player.paused)) {
      stopFrameLoop();
      updateReadout();
      setStatus(status, "Playback ended.", "idle");
    }
  };

  const listeners = [];
  const listen = (target, type, handler) => {
    target.addEventListener(type, handler);
    listeners.push(() => target.removeEventListener(type, handler));
  };

  players.forEach((player) => {
    listen(player, "play", onNativePlay);
    listen(player, "pause", onNativePause);
    listen(player, "seeking", onNativeSeeking);
    listen(player, "timeupdate", updateReadout);
    listen(player, "durationchange", updateReadout);
    listen(player, "loadedmetadata", updateReadout);
    listen(player, "waiting", onWaiting);
    listen(player, "stalled", onWaiting);
    listen(player, "canplay", onCanPlay);
    listen(player, "error", onMediaError);
    listen(player, "ended", onEnded);
  });

  root.querySelectorAll("[data-video-action]").forEach((button) => {
    const action = button.dataset.videoAction;
    const handler = () => {
      if (action === "play") void playPlayers();
      if (action === "pause") {
        pausePlayers();
        setStatus(status, "Both players paused.", "idle");
      }
      if (action === "restart") restartPlayers();
      if (action === "mute") toggleMute();
    };
    listen(button, "click", handler);
  });

  if (seek) {
    listen(seek, "input", () => {
      const max = Number(seek.max || 1000);
      seekPlayers(clamp(Number(seek.value) / max, 0, 1));
      setStatus(status, "Timeline moved for both players.", "idle");
    });
  }

  if (linkToggle) {
    listen(linkToggle, "change", () => {
      linked = linkToggle.checked;
      if (!linked) {
        stopFrameLoop();
        setStatus(status, "Players are independent.", "idle");
        return;
      }
      seekPlayers(getRatio(players[0]));
      setStatus(status, "Players linked at the current position.", "active");
      if (!players[0].paused) startFrameLoop();
    });
  }

  updateReadout();

  return {
    players,
    play: playPlayers,
    pause: () => {
      pausePlayers();
      setStatus(status, "Both players paused.", "idle");
    },
    seek: (ratio) => seekPlayers(clamp(Number(ratio), 0, 1)),
    setMuted: (muted) => {
      players.forEach((player) => {
        player.muted = Boolean(muted);
      });
      if (muteButton) {
        muteButton.textContent = muted ? "Unmute" : "Mute";
        muteButton.setAttribute("aria-pressed", String(Boolean(muted)));
      }
    },
    restart: restartPlayers,
    dispose: () => {
      destroyed = true;
      stopFrameLoop();
      listeners.splice(0).forEach((remove) => remove());
      delete root.dataset.videoControlsAttached;
    },
  };
}

export function attachPromptTabs(documentRoot = document) {
  const nav = documentRoot.querySelector("[data-case-tabs]");
  if (!nav || nav.dataset.tabsAttached === "true") return null;
  const tabs = [...nav.querySelectorAll("[data-case-tab]")];
  const panels = [...documentRoot.querySelectorAll("[data-case-panel]")];
  if (!tabs.length || !panels.length) return null;

  nav.dataset.tabsAttached = "true";
  nav.setAttribute("role", "tablist");
  tabs.forEach((tab) => {
    const id = tab.dataset.caseTab;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-controls", id);
    tab.setAttribute("tabindex", "-1");
  });
  panels.forEach((panel) => {
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("tabindex", "-1");
  });

  const knownIds = new Set(tabs.map((tab) => tab.dataset.caseTab));
  const fragmentId = window.location.hash.slice(1);
  let activeId = knownIds.has(fragmentId) ? fragmentId : tabs.find((tab) => tab.getAttribute("aria-current") === "true")?.dataset.caseTab;
  if (!activeId) activeId = tabs[0].dataset.caseTab;

  const activate = (id, updateUrl = true) => {
    if (!knownIds.has(id)) return;
    activeId = id;
    tabs.forEach((tab) => {
      const selected = tab.dataset.caseTab === id;
      tab.setAttribute("aria-selected", String(selected));
      tab.setAttribute("aria-current", String(selected));
      tab.setAttribute("tabindex", selected ? "0" : "-1");
    });
    panels.forEach((panel) => {
      const selected = panel.dataset.casePanel === id;
      panel.hidden = !selected;
      panel.setAttribute("aria-hidden", String(!selected));
    });
    if (updateUrl && window.history?.replaceState) {
      window.history.replaceState(null, "", `#${id}`);
    }
  };

  tabs.forEach((tab, index) => {
    tab.addEventListener("click", (event) => {
      event.preventDefault();
      activate(tab.dataset.caseTab);
    });
    tab.addEventListener("keydown", (event) => {
      let nextIndex = index;
      if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = (index + 1) % tabs.length;
      if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = (index - 1 + tabs.length) % tabs.length;
      if (event.key === "Home") nextIndex = 0;
      if (event.key === "End") nextIndex = tabs.length - 1;
      if (nextIndex !== index || event.key === "Home" || event.key === "End") {
        event.preventDefault();
        const next = tabs[nextIndex];
        next.focus();
        activate(next.dataset.caseTab);
      }
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        activate(tab.dataset.caseTab);
      }
    });
  });

  activate(activeId, false);
  return { activate, tabs, panels, get activeId() { return activeId; } };
}

function boot() {
  attachPromptTabs(document);
  document.querySelectorAll("[data-video-comparison]").forEach((root) => attachVideoComparison(root));
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
}
