// Which instrument (and preview voice) a track gets from its name, including
// piano scores whose parts are named for the hands, as on Mutopia. Plain Node.
//
//   npm test

import assert from "node:assert/strict";
import { instrumentFor, voiceFamily } from "../src/instruments.ts";

const first = (name: string) => instrumentFor(name, false)[0];

// Piano, by instrument name or by staff/hand name (Mutopia's Schubert Impromptus).
for (const n of ["Piano", "pianoUp", "Keys", "Keyboard", "up", "upII", "upII:", "down", "downIII", "down:1",
                 "upper", "Lower", "upper:one", "treble", "RH", "LH", "Harpsichord"]) {
  assert.equal(first(n), "Electric", `${n} is a piano part`);
}
// Not piano: words that merely start like a staff name, and the other families.
for (const n of ["update", "downbeat", "uptempo"]) assert.equal(first(n), "Wavetable", `${n} is not a piano part`);
assert.equal(first("C. Greenwood-Fingered Bass"), "Operator");
assert.equal(first("bass"), "Operator", "a 'bass' staff is a bass, not a piano hand");
assert.equal(first("J. Greenwood-Clean Guitar"), "Tension");
assert.equal(first("cello"), "Tension");
assert.equal(first("Yorke-Lead Vocals"), "Wavetable");
assert.deepEqual(instrumentFor("anything", true), ["Drum Rack"]);
assert.deepEqual(instrumentFor("up", false), ["Electric", "Wavetable"], "Wavetable stays the fallback");

// Preview voices follow the first choice.
assert.equal(voiceFamily("up", false), 3);
assert.equal(voiceFamily("guitar", false), 1);
assert.equal(voiceFamily("bass", false), 2);
assert.equal(voiceFamily("lead", false), 0);
assert.equal(voiceFamily("up", true), 0, "drums aren't voiced");

console.log("instruments ok");
