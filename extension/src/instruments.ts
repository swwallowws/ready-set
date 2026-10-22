// Which stock instrument a built track gets, from its name, and the matching
// preview voice. insertDevice only takes a built-in device NAME with its
// DEFAULT preset (the SDK can't load the website template's tuned MPE presets),
// so this just makes each track audible out of the box. Candidates are tried
// in order: the first that loads wins (Tension, Operator and Electric come with
// Live Suite; Wavetable is the fallback).
//
// No SDK imports, so it runs under plain Node for tests.

// Piano-like parts: named for the instrument, or for the hands/staves of a
// piano score ("up", "upII:", "down", "lower", "treble", "RH"...), as many
// Mutopia files are. A bare "up"/"down" is a piano staff far more often than
// anything else.
const PIANO = /piano|keyboard|\bkeys?\b|clavier|harpsichord/;
const PIANO_STAFF = /^(up|down|upper|lower|treble|rh|lh)(i*|\d*)(:|$|\s)/;

export function instrumentFor(name: string, isDrums: boolean): string[] {
  if (isDrums) return ["Drum Rack"];
  const n = name.toLowerCase().trim();
  if (/bass/.test(n)) return ["Operator", "Wavetable"];
  if (/guitar|gtr/.test(n)) return ["Tension", "Wavetable"];
  if (/string|violin|viola|cello|orchestr|ensemble/.test(n)) return ["Tension", "Wavetable"];
  if (PIANO.test(n) || PIANO_STAFF.test(n)) return ["Electric", "Wavetable"];
  return ["Wavetable"];
}

/** The preview voice for a track, matching its first-choice instrument:
 *  0 pad (Wavetable), 1 plucked string (Tension), 2 bass (Operator),
 *  3 electric piano (Electric). */
export function voiceFamily(name: string, isDrums: boolean): number {
  if (isDrums) return 0;
  const first = instrumentFor(name, false)[0];
  return first === "Tension" ? 1 : first === "Operator" ? 2 : first === "Electric" ? 3 : 0;
}
