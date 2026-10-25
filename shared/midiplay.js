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
//   zoomOnRoll(canvas, roll);          // pinch or ⌘ + scroll zooms, a double-click shows it all
//
// The bank comes from the design's fetchSoundfont: the one copy every studio on the site
// shares, fetched once and kept in the Cache API, else this site's own; bump SF_VERSION when a
// design sync changes gm.sf3.
import { iconButton } from "./vendor/design/iconbutton.js";
import { seekable, clampTime, heardTime } from "./vendor/design/playhead.js";
import { fetchSoundfont } from "./vendor/design/sound/soundfont.js";

const VENDOR = new URL("./vendor/design/sound/spessasynth/", import.meta.url);
const SF_VERSION = "1";
const SF_URL = new URL(`./vendor/design/sound/gm.sf3?v=${SF_VERSION}`, import.meta.url).href;
const OLD_CACHE = "ready-set-soundfont";       // where this site kept its own copy before
const RAMP = 0.02;

let bank = null;
/** the shared bank's bytes: from the browser's cache, else fetched once and cached */
export function soundfontBytes() {
  bank = bank || fetchSoundfont(SF_URL, { retire: [OLD_CACHE] });
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
  // Playing, they show what is heard: the synth's time less the output's delay (200 ms or
  // more on Bluetooth), held at the last start or seek (`jumpedTo`) until its sound arrives.
  let scrubAt = null, jumpedTo = 0;
  const shown = () => scrubAt ?? (p.playing ? heardTime(p.time, jumpedTo, p.ctx) : p.time);
  function paint() {
    const d = p.duration, t = Math.min(shown(), d || 0);
    if (!dragging) { seek.value = String(d ? Math.round((t / d) * 1000) : 0); paintSeek(d ? t / d : 0); }
    clock.textContent = `${fmt(t)} / ${fmt(d)}`;
    seek.setAttribute("aria-valuetext", `${fmt(t)} of ${fmt(d)}`);
    playBtn.setPressed(p.playing);
    const off = !p.loaded;
    playBtn.el.disabled = off; stopBtn.el.disabled = off; seek.disabled = off;
  }

  // spessasynth's Sequencer moves its time on the audio thread: after `currentTime = t`
  // its getter still gives the old time until the audio thread answers with a
  // "timeChange" (a frame or so later). Until then the player reports the target, so
  // nothing draws the head back at the old place (a flash, or for a quick paused click
  // the old place for good).
  let target = null, targetUntil = 0;
  function setTime(t) {
    target = Math.max(0, Math.min(t, p._duration));
    jumpedTo = target;
    targetUntil = performance.now() + 1000;           // in case no answer ever comes
    p.seq.currentTime = target;
  }
  function timeChanged(t) {
    if (target == null || Math.abs(t - target) > 1e-3) return;   // an older seek's answer
    target = null;
    if (!p.playing && p.loaded) { paint(); onTick?.(p.time); }
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
        this.seq.eventHandler.addEvent("timeChange", "midiplay", timeChanged);
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
      setTime(0);
      this.seq.pause();
      this.loaded = true;
      paint();
      return true;
    },
    get duration() { return this._duration; },
    get time() {
      if (!this.seq || !this.loaded) return 0;
      if (target != null && performance.now() < targetUntil) return target;   // a seek on its way
      return Math.max(0, Math.min(this.seq.currentTime, this._duration));
    },
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
    /** the drag let go at t (null: a touch was taken over for scrolling, the sound
     *  stays where it is) */
    endScrub(t) {
      scrubAt = null;
      if (t != null) { this.seek(t); return; }
      paint();
      if (!this.playing) onTick?.(this.time);
    },
    play(at) {
      if (!this.loaded) { paint(); return; }
      this.unlock();
      if (at != null) setTime(at);
      else if (this.time >= this._duration - 0.05) setTime(0);
      else jumpedTo = this.time;                      // a resume: heard from where it paused
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
      setTime(0);
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
      setTime(t);
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
      setTime(0);
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
// 4/4), turning the page as the playhead leaves the view. Drawn with the shared TabridgeRoll
// (roll.js), per the design system's roll.md: pitched notes shaded by pitch, the sounding
// ones at full accent with an ink outline, the playhead a thin accent line. Drums stay out.
// With `scrollbar` (an empty element under the roll), zoomed in it scrolls like Rearranged's
// parts strip: only the bars on show are drawn, and the element holds a real scrollbar over
// the whole song (a canvas as wide as a long song zoomed in would be too big to draw).
export function rollView(canvas, { beats: span = 32, scrollbar = null } = {}) {
  const R = window.TabridgeRoll;
  const ctx = canvas.getContext("2d");
  let pal = null, notes = [], range = [48, 72, 48, 72], last = null, end = span;
  let from = 0;                                    // the first beat on show
  let spacer = null;
  if (scrollbar) {
    scrollbar.classList.add("roll-scrollbar");
    spacer = document.createElement("div");
    scrollbar.replaceChildren(spacer);
    // a drag on the scrollbar (or a sideways scroll on it) moves the view through the song
    scrollbar.addEventListener("scroll", () => {
      const total = spacer.offsetWidth;
      const to = total ? (scrollbar.scrollLeft / total) * view.whole : 0;
      if (Math.abs(to - from) < 1e-6) return;     // the view set it itself
      from = to;
      paint(last);
    });
  }
  const maxFrom = () => Math.max(0, view.whole - span);
  // the scrollbar's length and place follow the zoom and the view
  function syncBar() {
    if (!scrollbar) return;
    const w = scrollbar.clientWidth;
    const total = span >= view.whole ? w : (w * view.whole) / span;
    spacer.style.width = `${total}px`;
    scrollbar.classList.toggle("whole", span >= view.whole);
    scrollbar.scrollLeft = (from / view.whole) * total;
  }
  // the pitch rows: the song's own span, at least two octaves, a little room above and below
  function setRange() {
    const ps = notes.map((x) => x.pitch);
    const nlo = ps.length ? Math.min(...ps) : 60, nhi = ps.length ? Math.max(...ps) : 60;
    let lo = nlo - 2, hi = nhi + 2;
    if (hi - lo < 24) { const pad = Math.ceil((24 - (hi - lo)) / 2); lo -= pad; hi += pad; }
    range = [lo, hi, nlo, nhi];
  }

  function paint(beat) {
    pal = pal || R.palette(canvas);
    const dpr = Math.min(window.devicePixelRatio || 1, 2), box = canvas.getBoundingClientRect();
    if (!box.width || !box.height) return;
    const cw = Math.round(box.width * dpr), ch = Math.round(box.height * dpr);
    if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const W = box.width, H = box.height, to = from + span;
    ctx.fillStyle = pal.ground; ctx.fillRect(0, 0, W, H);
    if (!notes.length) return;
    const [lo, hi, nlo, nhi] = range, row = H / (hi - lo + 1);
    const x = (b) => ((b - from) / span) * W;
    R.bands(ctx, pal, 0, 0, W, lo, hi, row, true);
    ctx.fillStyle = pal.line;                      // bar lines
    for (let b = Math.ceil(from / 4) * 4; b <= to; b += 4) ctx.fillRect(Math.round(x(b)), 0, 1, H);
    for (const n of notes) {
      if (n.start >= to || n.start + n.dur <= from) continue;
      const s = Math.max(n.start, from), e = Math.min(n.start + n.dur, to);
      const now = beat != null && beat >= n.start && beat < n.start + n.dur;
      R.note(ctx, pal, x(s), (hi - n.pitch) * row, x(e) - x(s), row, R.shade(n.pitch, nlo, nhi), now);
    }
    if (beat != null && beat >= from && beat <= to) {
      ctx.fillStyle = pal.acc;
      ctx.fillRect(Math.round(x(beat)), 0, 1.5, H);
    }
  }

  const view = {
    /** the notes-JSON of the piece ({ tracks: [{ isDrums, notes: [{ pitch, start, dur }] }] }, beats) */
    setSong(song) {
      notes = (song?.tracks || []).filter((t) => !t.isDrums).flatMap((t) => t.notes);
      end = Math.max(4, ...(song?.tracks || []).flatMap((t) => t.notes.map((x) => x.start + x.dur)));
      setRange();
      from = 0;
      view.draw(last);
    },
    /** which page of `span` beats is on show */
    get page() { return Math.floor(from / span + 1e-6); },
    /** beats on show at once; the whole song is `whole` */
    get span() { return span; },
    get whole() { return Math.ceil(end / 4) * 4; },
    /** the first beat on show */
    get from() { return from; },
    /** zoom to `beats` on show (a bar up to the whole song): around the playhead while it
     *  plays, around the middle of the view otherwise */
    setSpan(beats) {
      const mid = last ?? from + span / 2;
      span = Math.max(4, Math.min(view.whole, Math.round(beats)));
      from = Math.max(0, Math.min(maxFrom(), mid - span / 2));
      syncBar();
      paint(last);
    },
    /** move the view sideways by `px` pixels (a sideways scroll on the roll) */
    scrollBy(px) {
      if (span >= view.whole) return;
      const box = canvas.getBoundingClientRect();
      from = Math.max(0, Math.min(maxFrom(), from + (px / (box.width || 1)) * span));
      syncBar();
      paint(last);
    },
    /** the beat the playhead was last drawn at (null: none drawn) */
    get head() { return last; },
    /** the beat at `frac` (0 left edge, 1 right edge) of the view, kept a hair inside it so
     *  a click at an edge doesn't turn the page */
    beatAt(frac) {
      const b = from + Math.max(0, Math.min(1, frac || 0)) * span;
      return Math.min(from + span - 0.01, from > 0 ? Math.max(from + 0.01, b) : b);
    },
    /** draw with the playhead at `beat`, turning the page as it leaves the view (null: back
     *  at the start, no playhead). A view scrolled away from the playhead stays put. */
    draw(beat = null) {
      const out = (b) => b != null && (b < from || b >= from + span);
      const was = from;
      if (beat == null) from = 0;
      else if (out(beat) && !out(last)) from = Math.min(maxFrom(), Math.floor(beat / span) * span);
      last = beat;
      if (from !== was || (scrollbar && !spacer.style.width)) syncBar();
      paint(beat);
    },
    /** colours changed (theme, scheme): resolve them again and redraw */
    repaint() { pal = null; syncBar(); paint(last); },
  };
  return view;
}

// ---- zoom, as in Rearranged's parts editor: pinch or ⌘/Ctrl + scroll on the roll zooms in
// and out, a double-click shows the whole song (another one goes back to eight bars).
export function zoomOnRoll(canvas, roll) {
  const wheel = (e) => {
    if (!e.ctrlKey && !e.metaKey) return;            // a trackpad pinch arrives as Ctrl + wheel
    e.preventDefault();
    roll.setSpan(roll.span * Math.exp(e.deltaY * 0.004));   // a mouse notch (100) is about a third
  };
  // a sideways scroll on the roll (a trackpad swipe, or Shift + wheel) moves through the song
  const side = (e) => {
    if (e.ctrlKey || e.metaKey || !roll.scrollBy) return;
    const dx = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.shiftKey ? e.deltaY : 0;
    if (!dx || roll.span >= roll.whole) return;
    e.preventDefault();
    roll.scrollBy(dx);
  };
  const dbl = () => roll.setSpan(roll.span >= roll.whole ? 32 : roll.whole);
  canvas.addEventListener("wheel", wheel, { passive: false });
  canvas.addEventListener("wheel", side, { passive: false });
  canvas.addEventListener("dblclick", dbl);
  return () => {
    canvas.removeEventListener("wheel", wheel); canvas.removeEventListener("wheel", side);
    canvas.removeEventListener("dblclick", dbl);
  };
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
