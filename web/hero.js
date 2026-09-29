// The hero's bassline (top of the main page): one bar of drop-D bass played through
// spessasynth with the design system's shared General MIDI bank, on a picked electric bass.
// The approach is Starling's (voxmpe/studio-ui/src/voices.ts): every sounding note on its
// own channel, the pitch curve riding the pitch wheel at a ±48 semitone range (RPN 0), and
// the loudness curve riding CC11 (expression) at one fixed velocity.
//
// A legato run is one note (one channel, one attack) whose pitch glides from step to step,
// as a hammer-on or pull-off does. The bend and the vibrato are the curves the old
// oscillator played: the dive glides to its target linearly in frequency over the first 90
// percent of the note, the vibrato swings ±40 cents at 5.5 Hz. Transpose moves the pitch
// wheel of the notes already sounding and the key of the next ones, so it works while the
// bar plays.
//
// Pure parts (the notes, their groups, the pitch and loudness curves, bendValue) have no
// DOM, so scripts/test_hero.mjs checks them in node; heroPlayer() needs Web Audio.

// ---- the bar: p = semitones above MIDI 40 (E2). v = velocity 0..1 (ghosts play quieter).
// bend = semitones glided to over the note, vib = vibrato hold, leg = legato from the
// previous note. The back half of that groove: a chug up to the octave, a legato run, a
// vibrato hold and a closing dive.
export const D = -2, OCT = 10;
export const NOTES = [
  { b: 0,    l: 0.25, p: D,   v: 1 },
  { b: 0.25, l: 0.25, p: D,   v: 0.45 },
  { b: 0.5,  l: 0.25, p: D,   v: 0.8 },
  { b: 0.75, l: 0.25, p: OCT, v: 0.75 },
  { b: 1,    l: 0.25, p: D,   v: 0.45 },
  { b: 1.25, l: 0.25, p: 1,   v: 0.7, leg: true },
  { b: 1.5,  l: 0.5,  p: -1,  v: 0.8, leg: true },
  { b: 2,    l: 1,    p: OCT, v: 0.9, vib: true },
  { b: 3,    l: 1,    p: D,   v: 1,   bend: -4 },
];
export const BEATS = 4, BPM = 100, SPB = 60 / BPM, TOTAL = BEATS * SPB;
/** MIDI note of p = 0 (E2). */
export const BASE = 40;
/** General MIDI Electric Bass (pick), 0-based: the chug and the dive want a pick's attack. */
export const PROGRAM = 34;
export const BEND_RANGE = 48;
/** A legato step's glide (s), linear in frequency, as the old oscillator ramped it. */
export const GLIDE = 0.028;
export const VIB_HZ = 5.5, VIB_SEMIS = 0.4;
/** The dive reaches its target at this share of the note, then holds. */
export const BEND_END = 0.9;
/** Pitch wheel updates at most this often (s), expression this often. */
export const BEND_STEP = 0.004, EXPR_STEP = 0.01;
/** One fixed velocity: loudness comes from CC11, so every note has the same timbre. */
export const VELOCITY = 100;
/** CC7 (channel volume) as General MIDI sets it at reset. */
export const VOLUME = 100;
/** How long a channel stays reserved after its note ends, for the sample's release. */
const RELEASE = 0.8;
/** Channels a note can take (0-based): all but 9, the drums. */
export const CHANNELS = Array.from({ length: 16 }, (_, i) => i).filter((c) => c !== 9);

const CC_VOLUME = 7, CC_EXPRESSION = 11, CC_ALL_SOUND_OFF = 120, CC_ALL_NOTES_OFF = 123;

/** Pitch wheel value for an offset in semitones at BEND_RANGE (as Starling's mpe-midi.ts). */
export const bendValue = (semis) => {
  const x = 8192 + semis * (8192 / BEND_RANGE);
  return Math.min(16383, Math.max(0, Math.sign(x) * Math.round(Math.abs(x))));
};
/** CC11 for a 0..1 amplitude: SoundFont synths apply CC11 as a squared gain, so the square
 * root keeps the sounding amplitude proportional to the curve. */
export const exprValue = (amp) => Math.round(127 * Math.sqrt(Math.min(1, Math.max(0, amp))));

/** Notes joined into what sounds as one note: a legato note that starts where the previous
 * one ends continues it. Times in seconds from the start of the bar. */
export function groups(notes = NOTES) {
  const out = [];
  let cur = null;
  for (const n of notes) {
    const contig = cur && Math.abs(n.b - cur.endBeat) < 0.02;
    if (n.leg && contig) { cur.segs.push(n); cur.endBeat = n.b + n.l; }
    else { cur = { sb: n.b, endBeat: n.b + n.l, segs: [n] }; out.push(cur); }
  }
  return out.map((g) => ({ segs: g.segs, start: g.sb * SPB, end: g.endBeat * SPB, root: g.segs[0].p, v: g.segs[0].v }));
}

// linear in frequency between two pitches (semitones), as a Web Audio frequency ramp moves
const hzLerp = (a, b, u) => 12 * Math.log2(2 ** (a / 12) + (2 ** (b / 12) - 2 ** (a / 12)) * Math.min(1, Math.max(0, u)));

/** The group's pitch at time t (s from the bar's start), in semitones above E2 before
 * Transpose: the curve the synth's pitch wheel follows. */
export function pitchAt(g, t) {
  let p = g.segs[0].p;                        // the pitch as it stands at the current step's start
  let out = p;
  for (let i = 0; i < g.segs.length; i++) {
    const n = g.segs[i], st = n.b * SPB, dur = n.l * SPB;
    if (i > 0 && t < st) break;
    const from = p, glideEnd = i > 0 ? st + GLIDE : st;
    let base;
    if (i > 0 && t < glideEnd) base = hzLerp(from, n.p, (t - st) / GLIDE);
    else if (n.bend) base = hzLerp(n.p, n.p + n.bend, (t - glideEnd) / (st + dur * BEND_END - glideEnd));
    else base = n.p;
    out = base + (n.vib && t >= st ? VIB_SEMIS * Math.sin(2 * Math.PI * VIB_HZ * (t - st)) : 0);
    p = n.bend ? n.p + n.bend : n.p;          // where this step leaves the pitch for the next
  }
  return out;
}

/** The group's loudness at time t, 0..1: its first note's velocity (ghosts sit back), fading
 * out over its last 120 ms (at most a third of it), as the old envelope did. The old 20 ms
 * fade-in was only there to spare the oscillator a click; the sample has its own attack. */
export function loudnessAt(g, t) {
  const level = 0.3 + 0.7 * g.v, rel = Math.min(0.12, (g.end - g.start) * 0.35);
  if (t <= g.end - rel) return level;
  return level * Math.max(0, (g.end - t) / rel);
}

/** Plays the bar's groups from AudioContext time `at`. pump() hands the synth what falls in
 * the next `ahead` seconds; the pitch wheel is worked out as it is sent, so a change of
 * transpose reaches the notes already sounding within `ahead`. */
export class Scheduler {
  constructor(port) {
    this.port = port;
    this.busy = new Map();                    // channel -> AudioContext time it is taken until
    this.pending = []; this.live = []; this.used = new Set();
    this.running = false; this.transpose = 0; this.at = 0; this.sentUntil = 0;
  }
  start(gs, at, transpose) {
    this.pending = [...gs].sort((a, b) => a.start - b.start);
    this.live = []; this.used.clear();
    this.at = at; this.sentUntil = at; this.transpose = transpose; this.running = true;
  }
  ctx(t) { return this.at + t; }
  channel() {
    let best = CHANNELS[0];
    for (const c of CHANNELS) if ((this.busy.get(c) ?? 0) < (this.busy.get(best) ?? 0)) best = c;
    return best;
  }
  bendOf(v, t) { return bendValue(BASE + pitchAt(v.g, t) + this.transpose - v.key); }
  pump(now, ahead) {
    if (!this.running) return;
    const horizon = now + ahead, P = this.port;
    const send = (t) => { const at = Math.max(this.ctx(t), now); this.sentUntil = Math.max(this.sentUntil, at); return at; };
    while (this.pending.length && this.ctx(this.pending[0].start) <= horizon) {
      const g = this.pending.shift(), ch = this.channel();
      this.busy.set(ch, this.ctx(g.end) + RELEASE);
      this.used.add(ch);
      this.live.push({ g, ch, key: BASE + g.root + this.transpose, on: false, off: false, tB: 0, tE: 0, lastB: NaN, lastE: NaN });
    }
    for (const v of this.live) {
      const g = v.g;
      if (!v.on) {                            // wheel and expression first, so it starts in tune
        const at = send(g.start);
        v.lastB = this.bendOf(v, g.start); v.lastE = exprValue(loudnessAt(g, g.start));
        P.bend(v.ch, v.lastB, at); P.cc(v.ch, CC_EXPRESSION, v.lastE, at); P.on(v.ch, v.key, VELOCITY, at);
        v.on = true; v.tB = g.start + BEND_STEP; v.tE = g.start + EXPR_STEP;
      }
      for (; v.tB < g.end && this.ctx(v.tB) <= horizon; v.tB += BEND_STEP) {
        // each value holds for a step, so it takes the curve at the step's middle
        const b = this.bendOf(v, Math.min(v.tB + BEND_STEP / 2, g.end));
        if (b !== v.lastB) { P.bend(v.ch, b, send(v.tB)); v.lastB = b; }
      }
      for (; v.tE < g.end && this.ctx(v.tE) <= horizon; v.tE += EXPR_STEP) {
        const e = exprValue(loudnessAt(g, v.tE));
        if (e !== v.lastE) { P.cc(v.ch, CC_EXPRESSION, e, send(v.tE)); v.lastE = e; }
      }
      if (!v.off && this.ctx(g.end) <= horizon) { P.off(v.ch, v.key, send(g.end)); v.off = true; }
    }
    this.live = this.live.filter((v) => !v.off);
    if (!this.pending.length && !this.live.length) this.running = false;
  }
  /** Silence the run now (Starling's way): its channels go quiet at once, and a reset queued
   * after the last event it sent clears whatever is still waiting in the synth. */
  cancel(now) {
    const clearAt = Math.max(this.sentUntil, now) + 0.003;
    for (const ch of this.used) {
      if ((this.busy.get(ch) ?? 0) <= now) continue;
      this.port.cc(ch, CC_VOLUME, 0, 0);
      this.port.cc(ch, CC_ALL_NOTES_OFF, 0, 0);
      this.port.cc(ch, CC_ALL_SOUND_OFF, 0, clearAt);
      this.port.cc(ch, CC_VOLUME, VOLUME, clearAt);
      this.busy.set(ch, clearAt + 0.005);
    }
    this.running = false; this.pending = []; this.live = []; this.used.clear();
  }
}

// ---- in the page: one AudioContext made inside the first click, one synth ----------------
const AHEAD = 0.08, AHEAD_HIDDEN = 1, TICK_MS = 15;
/** The sampled bass comes out quieter than the old triangle; this brings it level. */
const GAIN = 1.6;

export function heroPlayer() {
  let ctx = null, out = null, meter = null, synth = null, loading = null, sched = null, timer = 0, op = 0, offset = null;
  const h = {
    playing: false, startedAt: 0, transpose: 0,
    /** load the synth (inside a click: it makes the AudioContext) */
    load() {
      if (!ctx) {
        ctx = new AudioContext();
        out = ctx.createGain(); out.gain.value = GAIN; out.connect(ctx.destination);
        meter = ctx.createAnalyser(); out.connect(meter);
      }
      ctx.resume().catch(() => {});
      loading = loading || (async () => {
        const vendor = new URL("./shared/vendor/design/sound/spessasynth/", import.meta.url);
        const { soundfontBytes } = await import("./shared/midiplay.js");
        const [lib, bytes] = await Promise.all([
          import(new URL("spessasynth_lib.min.js", vendor).href), soundfontBytes(),
          ctx.audioWorklet.addModule(new URL("spessasynth_processor.min.js", vendor).href),
        ]);
        const s = new lib.WorkletSynthesizer(ctx);
        // spessasynth schedules on its own clock, which starts behind the AudioContext's by
        // however long the worklet took to start (about 25 ms), then runs at the same rate.
        // Every message from the worklet carries its clock; a message can only arrive late, so
        // the largest difference seen is the offset (as You Suck At Drums' voices.js does).
        s.worklet.port.addEventListener("message", (e) => {
          const t = e.data && e.data.currentTime;
          if (typeof t !== "number") return;
          const d = t - ctx.currentTime;
          if (offset === null || d > offset) offset = d;
        });
        s.connect(out);
        await s.soundBankManager.addSoundBank(bytes.slice(0), "main");
        await s.isReady;
        for (const ch of CHANNELS) {
          s.pitchWheelRange(ch, BEND_RANGE);
          s.controllerChange(ch, CC_VOLUME, VOLUME);
          s.programChange(ch, PROGRAM);
        }
        // a context time on the synth's clock; 0 stays "now"
        const at = (time) => ({ time: time ? time + (offset || 0) : 0 });
        sched = new Scheduler({
          bend: (ch, v, t) => s.pitchWheel(ch, v, at(t)),
          cc: (ch, cc, v, t) => s.controllerChange(ch, cc, v, at(t)),
          on: (ch, key, vel, t) => s.noteOn(ch, key, vel, at(t)),
          off: (ch, key, t) => s.noteOff(ch, key, at(t)),
        });
        synth = s;
      })();
      loading.catch(() => { loading = null; });   // a failed load can be tried again
      return loading;
    },
    /** play the bar from the start; resolves with the AudioContext time it starts at, or
     * null if stop() came first */
    async play(transpose = h.transpose) {
      const my = ++op;
      h.transpose = transpose;
      await h.load();
      if (my !== op) return null;
      sched.cancel(ctx.currentTime);
      h.startedAt = ctx.currentTime + 0.06;
      sched.start(groups(), h.startedAt, h.transpose);
      const pump = () => sched.pump(ctx.currentTime, document.hidden ? AHEAD_HIDDEN : AHEAD);
      pump();
      clearInterval(timer);
      timer = setInterval(() => { pump(); if (!sched.running) clearInterval(timer); }, TICK_MS);
      h.playing = true;
      return h.startedAt;
    },
    /** stop now; at the natural end the notes are already off and ring out */
    stop(cut = true) {
      op++;
      clearInterval(timer);
      if (cut && sched && ctx) sched.cancel(ctx.currentTime);
      h.playing = false;
    },
    setTranspose(v) { h.transpose = v; if (sched) sched.transpose = v; },
    get now() { return ctx ? ctx.currentTime : 0; },
    get ready() { return !!synth; },
    get clockOffset() { return offset; },
    /** the output's peak right now (0 to 1): 0 means silence */
    peak() {
      if (!meter) return 0;
      const buf = new Float32Array(meter.fftSize);
      meter.getFloatTimeDomainData(buf);
      let m = 0;
      for (const x of buf) m = Math.max(m, Math.abs(x));
      return m;
    },
    /** for checks: the context and the synth's output, to listen in on */
    monitor() { return ctx && out ? { ctx, out } : null; },
  };
  return h;
}
