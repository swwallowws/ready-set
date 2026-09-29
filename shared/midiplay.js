// The website's MIDI preview: spessasynth (vendor/design/sound/spessasynth) playing the design system's
// shared General MIDI bank (vendor/design/sound/gm.sf3), the same sounds as every other tool
// that plays MIDI, drums on channel 10 from its Standard kit. Modelled on Rearranged's synth:
// one AudioContext made inside the first click, one synth, one sequencer, a gain and a level
// meter after it.
//
//   const player = midiPlayer(barEl, { onPlay, onTick });   // a play / stop / seek bar
//   player.unlock();                 // inside the click, before any await
//   await player.load(bytes);        // a Standard MIDI File (ArrayBuffer or Uint8Array)
//   player.play(at?);  player.stop();  player.toggle();  player.seek(seconds);
//   player.time, player.duration, player.playing, player.peak(), player.beatAt(seconds)
//
//   const roll = rollView(canvas);  roll.setSong(notesJson);  roll.draw(beat | null);
//   seekOnRoll(canvas, roll, player);  // click or drag on the roll moves the playhead
//
// The bank is fetched once and kept in the Cache API; bump SF_VERSION when a design sync
// changes gm.sf3.
import { iconButton } from "./vendor/design/iconbutton.js";
import { seekable, clampTime } from "./vendor/design/playhead.js";

const VENDOR = new URL("./vendor/design/sound/spessasynth/", import.meta.url);
const SF_VERSION = "1";
const SF_URL = new URL(`./vendor/design/sound/gm.sf3?v=${SF_VERSION}`, import.meta.url).href;
const SF_CACHE = "ready-set-soundfont";
const RAMP = 0.02;

let bank = null;
/** the shared bank's bytes: from the browser's cache, else fetched once and cached */
export function soundfontBytes() {
  bank = bank || (async () => {
    let cache = null;
    try { cache = await caches.open(SF_CACHE); } catch { /* no Cache API here: fetch every time */ }
    let res = cache && (await cache.match(SF_URL));
    if (!res) {
      res = await fetch(SF_URL);
      if (!res.ok) throw new Error(`the sounds did not load (${res.status})`);
      if (cache) {
        for (const old of await cache.keys()) if (old.url !== SF_URL) await cache.delete(old);
        await cache.put(SF_URL, res.clone()).catch(() => {});
      }
    }
    return res.arrayBuffer();
  })();
  bank.catch(() => { bank = null; });               // a failed load can be tried again
  return bank;
}

const fmt = (s) => {
  s = Math.max(0, Math.floor(s || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const toBuffer = (b) => (b instanceof ArrayBuffer ? b.slice(0) : b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));

export function midiPlayer(host, { onPlay, onStop, onTick } = {}) {
  // ---- the bar: play toggle, stop, a thin accent seek line, the time
  host.classList.add("midiplay");
  host.innerHTML = "";
  const playBtn = iconButton({ icon: "play", toggle: true, label: "Play", size: "s", onPress: (on) => (on ? p.play() : p.pause()) });
  const stopBtn = iconButton({ icon: "stop", label: "Stop", size: "s", onPress: () => p.stop() });
  const seekWrap = document.createElement("div");
  seekWrap.className = "range midiplay-seek";
  const seek = document.createElement("input");
  Object.assign(seek, { type: "range", min: "0", max: "1000", step: "1", value: "0" });
  seek.setAttribute("aria-label", "Position");
  seekWrap.append(seek);
  const clock = document.createElement("span");
  clock.className = "midiplay-time";
  host.append(playBtn.el, stopBtn.el, seekWrap, clock);

  let dragging = false;
  seek.addEventListener("pointerdown", () => { dragging = true; });
  const release = () => { dragging = false; };
  seek.addEventListener("pointerup", release);
  seek.addEventListener("pointercancel", release);
  seek.addEventListener("input", () => {
    paintSeek(+seek.value / 1000);
    p.seek((+seek.value / 1000) * p.duration);
  });
  seek.addEventListener("change", release);

  function paintSeek(frac) {
    seekWrap.style.setProperty("--fill", `${(Math.max(0, Math.min(1, frac)) * 100).toFixed(2)}%`);
  }
  // While the roll is dragged during playback, the head (and the slider) show the
  // pointer's time and the sound keeps going until the drag lets go (scrub / endScrub).
  let scrubAt = null;
  const shown = () => (scrubAt ?? p.time);
  function paint() {
    const d = p.duration, t = Math.min(shown(), d || 0);
    if (!dragging) { seek.value = String(d ? Math.round((t / d) * 1000) : 0); paintSeek(d ? t / d : 0); }
    clock.textContent = `${fmt(t)} / ${fmt(d)}`;
    seek.setAttribute("aria-valuetext", `${fmt(t)} of ${fmt(d)}`);
    playBtn.setPressed(p.playing);
    const off = !p.loaded;
    playBtn.el.disabled = off; stopBtn.el.disabled = off; seek.disabled = off;
  }

  let raf = 0;
  function loop() {
    cancelAnimationFrame(raf);
    const step = () => {
      paint();
      onTick?.(shown());
      if (p.playing) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  }

  const p = {
    ctx: null, synth: null, seq: null, out: null, meter: null, ready: null,
    loaded: false, playing: false, midi: null, op: 0, _duration: 0,
    /** make and resume the AudioContext: call inside a click or key press, before any await */
    unlock() {
      if (!this.ctx) this.ctx = new AudioContext();
      this.ctx.resume().catch(() => {});
      return this.ctx;
    },
    get audioOn() { return !!this.ctx && this.ctx.state === "running"; },
    init() {
      this.ready = this.ready || (async () => {
        this.unlock();
        const [lib, sf] = await Promise.all([import(new URL("spessasynth_lib.min.js", VENDOR).href), soundfontBytes()]);
        await this.ctx.audioWorklet.addModule(new URL("spessasynth_processor.min.js", VENDOR).href);
        const synth = new lib.WorkletSynthesizer(this.ctx);
        this.out = this.ctx.createGain();
        synth.connect(this.out);
        this.out.connect(this.ctx.destination);
        this.meter = this.ctx.createAnalyser();      // read by peak(): is anything sounding
        this.out.connect(this.meter);
        // a copy: the bank's bytes stay whole for the hero's synth, which shares them
        await synth.soundBankManager.addSoundBank(sf.slice(0), "main");
        await synth.isReady;
        this.synth = synth;
        this.seq = new lib.Sequencer(synth, { skipToFirstNoteOn: false });
        this.seq.eventHandler.addEvent("songEnded", "midiplay", () => this.ended());
      })();
      this.ready.catch(() => { this.ready = null; });       // a failed load can be tried again
      return this.ready;
    },
    /** load a MIDI file; stops whatever played. Resolves once it can play. */
    async load(bytes) {
      const my = ++this.op;
      this.halt();
      this.loaded = false; this.midi = null; this._duration = 0;
      paint();
      await this.init();
      if (my !== this.op) return false;
      const changed = new Promise((ok) => {
        this.seq.eventHandler.addEvent("songChange", "midiplay-load", () => ok());
        setTimeout(ok, 4000);
      });
      this.seq.loadNewSongList([{ binary: toBuffer(bytes), fileName: "preview.mid" }]);
      this.seq.loopCount = 0;
      this.seq.pause();
      await changed;
      this.seq.eventHandler.removeEvent("songChange", "midiplay-load");
      if (my !== this.op) return false;
      this._duration = this.seq.duration || 0;
      try { this.midi = await this.seq.getMIDI(); } catch { this.midi = null; }
      if (my !== this.op) return false;
      this._duration = this._duration || this.midi?.duration || 0;
      this.seq.currentTime = 0;
      this.seq.pause();
      this.loaded = true;
      paint();
      return true;
    },
    get duration() { return this._duration; },
    get time() { return this.seq && this.loaded ? Math.max(0, Math.min(this.seq.currentTime, this._duration)) : 0; },
    /** a moment in seconds as beats (quarter notes), through the file's own tempo map */
    beatAt(t) {
      if (this.midi) {
        try { return this.midi.secondsToMIDITicks(t) / this.midi.timeDivision; } catch { /* fall through */ }
      }
      return t * 2;                                  // 120 bpm, the MIDI default
    },
    /** beats (quarter notes) as seconds: the other way round from beatAt */
    secondsAt(beat) {
      if (this.midi) {
        try { return this.midi.midiTicksToSeconds(beat * this.midi.timeDivision); } catch { /* fall through */ }
      }
      return beat / 2;
    },
    /** the head is being dragged to t: paused, the place moves there (Play starts from
     *  it); playing, only the head and the slider follow, and endScrub moves the sound */
    scrub(t) {
      if (!this.loaded) return;
      if (!this.playing) { scrubAt = null; this.seek(t); return; }
      scrubAt = clampTime(t, this._duration);
      paint();
      onTick?.(scrubAt);
    },
    /** the drag let go at t (null: it was cancelled, the sound stays where it is) */
    endScrub(t) {
      scrubAt = null;
      if (t != null) { this.seek(t); return; }
      paint();
      if (!this.playing) onTick?.(this.time);
    },
    play(at) {
      if (!this.loaded) { paint(); return; }
      this.unlock();
      if (at != null) this.seq.currentTime = Math.max(0, Math.min(at, this._duration));
      else if (this.seq.currentTime >= this._duration - 0.05) this.seq.currentTime = 0;
      this.fade(1);
      this.seq.play();
      this.playing = true;
      onPlay?.();
      loop();
    },
    pause() {
      if (!this.playing) { paint(); return; }
      this.seq.pause();
      this.playing = false;
      paint();
      onStop?.();
    },
    stop() {
      if (!this.loaded) return;
      this.seq.pause();
      this.seq.currentTime = 0;
      this.seq.pause();
      this.playing = false;
      scrubAt = null;
      paint();
      onTick?.(null);
      onStop?.();
    },
    toggle() { this.playing ? this.pause() : this.play(); },
    seek(t) {
      if (!this.loaded) return;
      this.seq.currentTime = Math.max(0, Math.min(t, this._duration));
      if (!this.playing) { this.seq.pause(); paint(); onTick?.(this.time); }
    },
    /** stop without touching the bar: a new file is on its way */
    halt() {
      if (this.seq && this.loaded) this.seq.pause();
      this.playing = false;
      scrubAt = null;
      cancelAnimationFrame(raf);
    },
    ended() {
      this.playing = false;
      scrubAt = null;
      this.seq.pause();
      this.seq.currentTime = 0;
      this.seq.pause();
      paint();
      onTick?.(null);
      onStop?.();
    },
    fade(to) {
      const g = this.out.gain, now = this.ctx.currentTime;
      g.cancelScheduledValues(now);
      g.setValueAtTime(0, now);
      g.linearRampToValueAtTime(to, now + RAMP);
    },
    /** the output's peak right now (0 to 1): 0 means silence */
    peak() {
      if (!this.meter) return 0;
      const buf = new Float32Array(this.meter.fftSize);
      this.meter.getFloatTimeDomainData(buf);
      let m = 0;
      for (const x of buf) m = Math.max(m, Math.abs(x));
      return m;
    },
  };
  paint();
  return p;
}

// ---- a piano roll that follows the playhead: `beats` at a time (default 32, eight bars of
// 4/4), paging on as the playhead leaves the view. Drawn with the shared TabridgeRoll
// (roll.js), per the design system's roll.md: pitched notes shaded by pitch, the sounding
// ones at full accent with an ink outline, the playhead a thin accent line. Drums stay out.
export function rollView(canvas, { beats: span = 32 } = {}) {
  const R = window.TabridgeRoll;
  const ctx = canvas.getContext("2d");
  let pal = null, notes = [], page = -1, pageNotes = [], range = [48, 72], last = null;

  function setPage(n) {
    if (n === page) return;
    page = n;
    const from = n * span, to = from + span;
    pageNotes = notes.filter((x) => x.start < to && x.start + x.dur > from);
    const ps = (pageNotes.length ? pageNotes : notes).map((x) => x.pitch);
    const nlo = ps.length ? Math.min(...ps) : 60, nhi = ps.length ? Math.max(...ps) : 60;
    let lo = nlo - 2, hi = nhi + 2;
    if (hi - lo < 24) { const pad = Math.ceil((24 - (hi - lo)) / 2); lo -= pad; hi += pad; }
    range = [lo, hi, nlo, nhi];
  }

  const view = {
    /** the notes-JSON of the piece ({ tracks: [{ isDrums, notes: [{ pitch, start, dur }] }] }, beats) */
    setSong(song) {
      notes = (song?.tracks || []).filter((t) => !t.isDrums).flatMap((t) => t.notes);
      page = -1;
      view.draw(last);
    },
    get page() { return page; },
    /** the beat at `frac` (0 left edge, 1 right edge) of the page on show, kept a
     *  hair inside it so a click at an edge doesn't turn the page */
    beatAt(frac) {
      const from = Math.max(0, page) * span;
      const b = from + Math.max(0, Math.min(1, frac || 0)) * span;
      return Math.min(from + span - 0.01, from > 0 ? Math.max(from + 0.01, b) : b);
    },
    /** draw the page holding `beat` (null: the first page, no playhead) */
    draw(beat = null) {
      last = beat;
      pal = pal || R.palette(canvas);
      const dpr = Math.min(window.devicePixelRatio || 1, 2), box = canvas.getBoundingClientRect();
      if (!box.width || !box.height) return;
      const cw = Math.round(box.width * dpr), ch = Math.round(box.height * dpr);
      if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const W = box.width, H = box.height;
      setPage(Math.max(0, Math.floor((beat ?? 0) / span)));
      ctx.fillStyle = pal.ground; ctx.fillRect(0, 0, W, H);
      if (!notes.length) return;
      const [lo, hi, nlo, nhi] = range, row = H / (hi - lo + 1), from = page * span;
      R.bands(ctx, pal, 0, 0, W, lo, hi, row, true);
      ctx.fillStyle = pal.line;                      // bar lines
      for (let b = 0; b <= span; b += 4) ctx.fillRect(Math.round((b / span) * W), 0, 1, H);
      for (const n of pageNotes) {
        const s = Math.max(n.start, from), e = Math.min(n.start + n.dur, from + span);
        const x = ((s - from) / span) * W, w = ((e - s) / span) * W;
        const now = beat != null && beat >= n.start && beat < n.start + n.dur;
        R.note(ctx, pal, x, (hi - n.pitch) * row, w, row, R.shade(n.pitch, nlo, nhi), now);
      }
      if (beat != null) {
        ctx.fillStyle = pal.acc;
        ctx.fillRect(Math.round(((beat - from) / span) * W), 0, 1.5, H);
      }
    },
    /** colours changed (theme, scheme): resolve them again and redraw */
    repaint() { pal = null; view.draw(last); },
  };
  return view;
}

// ---- click or drag on the roll to move the playhead (the design system's playhead.js).
// The press and every move go to player.scrub (paused: the place moves; playing: only the
// head follows), the release to player.endScrub, which moves the sound once. The slider
// follows along. Returns the function that removes it.
export function seekOnRoll(canvas, roll, player) {
  return seekable(canvas, {
    enabled: () => player.loaded,
    toTime: (x, rect) => clampTime(player.secondsAt(roll.beatAt((x - rect.left) / rect.width)), player.duration),
    onScrub: (t) => player.scrub(t),
    onSeek: (t) => player.endScrub(t),
    onCancel: () => player.endScrub(null),
  });
}
