// The hero bassline's MIDI (web/hero.js), without a browser. Run: node scripts/test_hero.mjs
import assert from 'node:assert/strict';
import {
  SPB, BASE, BEND_RANGE, BEND_STEP, GLIDE, VIB_HZ, CHANNELS, groups, pitchAt, loudnessAt, bendValue, exprValue, Scheduler,
} from '../web/hero.js';

const near = (a, b, eps, what) => assert.ok(Math.abs(a - b) <= eps, `${what}: ${a} vs ${b}`);
const gs = groups();

// the legato run is one sounding note; everything else stands alone
assert.equal(gs.length, 7);
const run = gs[4];
assert.deepEqual(run.segs.map((n) => n.p), [-2, 1, -1]);
near(run.start, 1 * SPB, 1e-9, 'run start');
near(run.end, 2 * SPB, 1e-9, 'run end');

// legato: holds its pitch, glides to the next in GLIDE, then holds that
near(pitchAt(run, 1.2 * SPB), -2, 1e-9, 'before the hammer-on');
near(pitchAt(run, 1.25 * SPB + GLIDE / 2), 12 * Math.log2((2 ** (-2 / 12) + 2 ** (1 / 12)) / 2), 1e-9, 'mid glide, linear in Hz');
near(pitchAt(run, 1.25 * SPB + GLIDE + 0.01), 1, 1e-9, 'after the glide');
near(pitchAt(run, 1.9 * SPB), -1, 1e-9, 'the pull-off lands');

// vibrato: ±0.4 semitones at 5.5 Hz around the octave, from the note's start
const vib = gs[5];
near(pitchAt(vib, vib.start), 10, 1e-9, 'vibrato starts on the note');
near(pitchAt(vib, vib.start + 1 / (4 * VIB_HZ)), 10.4, 1e-9, 'vibrato top');
near(pitchAt(vib, vib.start + 3 / (4 * VIB_HZ)), 9.6, 1e-9, 'vibrato bottom');

// the dive: D to D-4, linear in Hz over 90% of the note, then held
const dive = gs[6];
near(pitchAt(dive, dive.start), -2, 1e-9, 'dive start');
const half = dive.start + 0.45 * SPB;
near(pitchAt(dive, half), 12 * Math.log2((2 ** (-2 / 12) + 2 ** (-6 / 12)) / 2), 1e-9, 'dive halfway, linear in Hz');
near(pitchAt(dive, dive.start + 0.95 * SPB), -6, 1e-9, 'dive held at its target');

// loudness: velocity sets the level, the last 120 ms fade out
near(loudnessAt(gs[0], 0.01), 1, 1e-9, 'full velocity');
near(loudnessAt(gs[1], gs[1].start + 0.01), 0.3 + 0.7 * 0.45, 1e-9, 'ghost note sits back');
assert.equal(loudnessAt(dive, dive.end), 0);

// wheel and expression values
assert.equal(bendValue(0), 8192);
assert.equal(bendValue(BEND_RANGE), 16383);
assert.equal(bendValue(-BEND_RANGE), 0);
assert.equal(bendValue(-4), 8192 - Math.round(4 * 8192 / BEND_RANGE));
assert.equal(exprValue(1), 127);
assert.equal(exprValue(0.25), 64);

// the scheduler: one channel per note, wheel and CC11 before each note-on, notes off at
// their ends, and a transpose that moves the wheel of a note already sounding
const log = [];
const port = {
  bend: (ch, v, t) => log.push({ k: 'bend', ch, v, t }),
  cc: (ch, cc, v, t) => log.push({ k: 'cc', ch, cc, v, t }),
  on: (ch, key, vel, t) => log.push({ k: 'on', ch, key, t }),
  off: (ch, key, t) => log.push({ k: 'off', ch, key, t }),
};
const s = new Scheduler(port);
s.start(gs, 10, 0);
for (let now = 10; now < 13; now += 0.015) s.pump(now, 0.08);
const ons = log.filter((e) => e.k === 'on');
assert.equal(ons.length, 7);
assert.equal(new Set(ons.map((e) => e.ch)).size, 7, 'a channel per note');
assert.ok(ons.every((e) => CHANNELS.includes(e.ch) && e.ch !== 9));
assert.deepEqual(ons.map((e) => e.key), [38, 38, 38, 50, 38, 50, 38]);
assert.equal(log.filter((e) => e.k === 'off').length, 7);
for (const on of ons) {
  const i = log.indexOf(on);
  assert.equal(log[i - 2].k, 'bend'); assert.equal(log[i - 1].cc, 11);
}
assert.equal(s.running, false, 'done after the bar');
// the dive's wheel ends 4 semitones down
const diveCh = ons[6].ch;
assert.equal(log.filter((e) => e.k === 'bend' && e.ch === diveCh).at(-1).v, bendValue(-4));

log.length = 0;
const t2 = new Scheduler(port);
t2.start(gs, 0, 0);
for (let now = 0; now < 1.5; now += 0.015) t2.pump(now, 0.08);   // into the vibrato note (1.2 s)
t2.transpose = 3;
for (let now = 1.5; now < 1.7; now += 0.015) t2.pump(now, 0.08);
const vibCh = log.filter((e) => e.k === 'on' && e.key === BASE + 10).at(-1).ch;   // the octave's second hit
const late = log.filter((e) => e.k === 'bend' && e.ch === vibCh && e.t > 1.6);
// (each wheel value holds for a step, so it is the curve at the step's middle)
assert.ok(late.length && late.every((e) => Math.abs((e.v - 8192) * BEND_RANGE / 8192 - (pitchAt(vib, e.t + BEND_STEP / 2) - 10 + 3)) < 0.01),
  'after the transpose the sounding note bends 3 semitones up');

console.log('hero ok');
