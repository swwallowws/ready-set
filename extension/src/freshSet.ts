// Whether the open set is "fresh": no track holds a clip yet. A fresh set takes
// the built song's tempo; a set with material keeps its own (notes sit on bars
// and beats, so the song plays in time either way).
//
// Empty MIDI or audio tracks, and tracks with devices but no clips, still
// count as fresh: only clips are material. Typed loosely (just what's read),
// so it runs under plain Node for tests, without the SDK.

type TrackLike = {
  arrangementClips?: readonly unknown[];
  clipSlots?: readonly { clip: unknown | null }[];
  takeLanes?: readonly { clips?: readonly unknown[] }[];
};

export function hasClips(t: TrackLike): boolean {
  return (t.arrangementClips?.length ?? 0) > 0
    || (t.clipSlots ?? []).some((s) => s.clip != null)
    || (t.takeLanes ?? []).some((l) => (l.clips?.length ?? 0) > 0);
}

export function isFreshSet(tracks: readonly TrackLike[]): boolean {
  return !tracks.some(hasClips);
}
