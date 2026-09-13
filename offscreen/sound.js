/**
 * offscreen/sound.js - Plays the timer chime on request from the worker.
 * Synthesized with WebAudio (no audio asset to ship): three rising tones,
 * loud enough to notice, short enough not to be annoying.
 */
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== "PLAY_CHIME") return;
  try {
    const ctx = new AudioContext();
    const notes = [523.25, 659.25, 783.99]; // C5 E5 G5
    notes.forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.frequency.value = f;
      const t = ctx.currentTime + i * 0.22;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.5, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
      o.connect(g).connect(ctx.destination);
      o.start(t);
      o.stop(t + 0.65);
    });
    setTimeout(() => ctx.close(), 1500);
  } catch (e) {
    console.warn("[Focus Agent] chime failed:", e.message);
  }
});
