/**
 * Subtle procedural Web Audio synthesizer (zero external audio files).
 */

export function createAudio() {
  let ctx = null;
  let muted = false;

  function ensureCtx() {
    if (muted) return null;
    if (!ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return null;
      ctx = new AudioCtx();
    }
    if (ctx.state === "suspended") {
      ctx.resume().catch(() => {});
    }
    return ctx;
  }

  function setMuted(val) {
    muted = !!val;
  }

  function isMuted() {
    return muted;
  }

  function playPluck(chordLength = 75) {
    const c = ensureCtx();
    if (!c) return;
    const now = c.currentTime;
    // Longer chords have slightly deeper pitch
    const freq = 290 - (chordLength - 38) * 1.4;

    const osc = c.createOscillator();
    const osc2 = c.createOscillator();
    const filter = c.createBiquadFilter();
    const gain = c.createGain();

    osc.type = "triangle";
    osc.frequency.setValueAtTime(freq, now);
    osc.frequency.exponentialRampToValueAtTime(freq * 0.99, now + 0.25);

    osc2.type = "sine";
    osc2.frequency.setValueAtTime(freq * 2, now);

    filter.type = "lowpass";
    filter.frequency.setValueAtTime(1600, now);
    filter.frequency.exponentialRampToValueAtTime(340, now + 0.28);

    gain.gain.setValueAtTime(0.001, now);
    gain.gain.linearRampToValueAtTime(0.14, now + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0008, now + 0.32);

    osc.connect(filter);
    osc2.connect(filter);
    filter.connect(gain);
    gain.connect(c.destination);

    osc.start(now);
    osc2.start(now);
    osc.stop(now + 0.35);
    osc2.stop(now + 0.35);
  }

  function playPour(wellCount = 1) {
    const c = ensureCtx();
    if (!c) return;
    const now = c.currentTime;

    // Gentle filtered water-pour rush (~1s)
    const duration = Math.min(1.45, 0.95 + wellCount * 0.04);
    const bufferSize = Math.floor(c.sampleRate * duration);
    const buffer = c.createBuffer(1, bufferSize, c.sampleRate);
    const data = buffer.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < bufferSize; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.997 * b0 + white * 0.029;
      b1 = 0.985 * b1 + white * 0.032;
      b2 = 0.950 * b2 + white * 0.048;
      data[i] = (b0 + b1 + b2) * 1.4;
    }

    const noise = c.createBufferSource();
    noise.buffer = buffer;

    const bp = c.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.setValueAtTime(520, now);
    bp.frequency.linearRampToValueAtTime(980, now + duration * 0.55);
    bp.frequency.linearRampToValueAtTime(640, now + duration);
    bp.Q.value = 1.6;

    const gain = c.createGain();
    gain.gain.setValueAtTime(0.001, now);
    gain.gain.linearRampToValueAtTime(0.11, now + 0.14);
    gain.gain.setValueAtTime(0.1, now + duration * 0.65);
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration);

    noise.connect(bp);
    bp.connect(gain);
    gain.connect(c.destination);
    noise.start(now);

    // Subtle droplet plinks staggered across claimed cells
    const plinks = Math.min(5, wellCount);
    for (let i = 0; i < plinks; i++) {
      const t = now + 0.08 + i * 0.11;
      const dOsc = c.createOscillator();
      const dGain = c.createGain();
      const f = 760 + Math.random() * 440;
      dOsc.type = "sine";
      dOsc.frequency.setValueAtTime(f, t);
      dOsc.frequency.exponentialRampToValueAtTime(f * 1.45, t + 0.07);
      dGain.gain.setValueAtTime(0.001, t);
      dGain.gain.linearRampToValueAtTime(0.045, t + 0.01);
      dGain.gain.exponentialRampToValueAtTime(0.0005, t + 0.09);
      dOsc.connect(dGain);
      dGain.connect(c.destination);
      dOsc.start(t);
      dOsc.stop(t + 0.1);
    }
  }

  function playBlocked() {
    const c = ensureCtx();
    if (!c) return;
    const now = c.currentTime;
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(145, now);
    osc.frequency.exponentialRampToValueAtTime(95, now + 0.12);
    gain.gain.setValueAtTime(0.08, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.14);
    osc.connect(gain);
    gain.connect(c.destination);
    osc.start(now);
    osc.stop(now + 0.15);
  }

  function playVictory() {
    const c = ensureCtx();
    if (!c) return;
    const now = c.currentTime;
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((freq, i) => {
      const t = now + i * 0.11;
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = "triangle";
      osc.frequency.setValueAtTime(freq, t);
      gain.gain.setValueAtTime(0.001, t);
      gain.gain.linearRampToValueAtTime(0.08, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0008, t + 0.55);
      osc.connect(gain);
      gain.connect(c.destination);
      osc.start(t);
      osc.stop(t + 0.58);
    });
  }

  return {
    setMuted,
    isMuted,
    playPluck,
    playPour,
    playBlocked,
    playVictory,
  };
}
