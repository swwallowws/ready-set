// A set is fresh when no track holds a clip: empty tracks, or tracks with only
// devices, still count as fresh. Plain Node, no Live.
//
//   npm test

import assert from "node:assert/strict";
import { isFreshSet } from "../src/freshSet.ts";

const empty = { arrangementClips: [], clipSlots: [{ clip: null }, { clip: null }], takeLanes: [] };
const clip = {};

assert.equal(isFreshSet([]), true, "no tracks at all");
assert.equal(isFreshSet([empty, empty]), true, "the default set's empty MIDI and audio tracks");
assert.equal(isFreshSet([{ ...empty, devices: [{}] }]), true, "an instrument on an empty track is not material");
assert.equal(isFreshSet([{}]), true, "a track that exposes nothing reads as empty");

assert.equal(isFreshSet([empty, { ...empty, arrangementClips: [clip] }]), false, "a clip in the arrangement");
assert.equal(isFreshSet([{ ...empty, clipSlots: [{ clip: null }, { clip }] }]), false, "a clip in a Session slot");
assert.equal(isFreshSet([{ ...empty, takeLanes: [{ clips: [] }, { clips: [clip] }] }]), false, "a clip on a take lane");

console.log("fresh set ok");
