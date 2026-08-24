// Keep the display awake (ported from pong-pilot). Silently no-ops where
// the Wake Lock API is unavailable or denied.

export function keepScreenAwake(): void {
  let lock: WakeLockSentinel | null = null;
  const request = async () => {
    try {
      if ("wakeLock" in navigator) {
        lock = await navigator.wakeLock.request("screen");
        lock.addEventListener("release", () => {
          lock = null;
        });
      }
    } catch {
      // unavailable / denied
    }
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && !lock) request();
  });
  request();
}
