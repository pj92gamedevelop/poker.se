// Web Worker: runs Monte Carlo sims so UI stays responsive.
importScripts("simcore.js");

let stopFlag = false;

self.onmessage = (ev) => {
  const m = ev.data;
  if (!m) return;

  if (m.type === "stop") {
    stopFlag = true;
    self.postMessage({ type:"stopped" });
    return;
  }

  if (m.type === "run") {
    stopFlag = false;
    const payload = m.payload;
    try {
      const res = runAll(payload, (pct, status) => {
        if (stopFlag) throw new Error("stopped");
        self.postMessage({ type:"progress", pct, status });
      }, () => stopFlag);

      self.postMessage({ type:"result", ev: res });
    } catch (e) {
      if ((e && e.message) === "stopped") {
        self.postMessage({ type:"stopped" });
      } else {
        self.postMessage({ type:"error", message: String(e && e.message ? e.message : e) });
      }
    }
  }
};
