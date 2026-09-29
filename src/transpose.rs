//! Semitone shift over the [`Song`] model, applied *before* MIDI export
//! (SPEC §7).
//!
//! Notes carry an absolute [`pitch`](crate::model::Note::pitch), so a `+N`
//! shift is just `pitch += N`, clamped to the 0–127 MIDI range.
//!
//! Drum tracks are excluded via [`TrackFilter`]: their note pitches are GM
//! percussion numbers, so shifting them would remap which drum plays (a kick
//! becomes a snare, etc.) rather than change pitch.

use crate::model::Song;

/// Which tracks a transpose applies to.
#[derive(Debug, Clone, Default)]
pub enum TrackFilter {
    /// Every track.
    #[default]
    All,
    /// Every track except drum tracks (see [`TrackFilter::exclude_drums`]).
    ExcludeDrums,
    /// Only the listed track indices.
    Only(Vec<usize>),
}

impl TrackFilter {
    /// Conventional default: shift everything except drum tracks, whose pitches
    /// are GM percussion numbers rather than musical pitch.
    pub fn exclude_drums() -> Self {
        TrackFilter::ExcludeDrums
    }

    fn includes(&self, index: usize, is_drums: bool) -> bool {
        match self {
            TrackFilter::All => true,
            TrackFilter::ExcludeDrums => !is_drums,
            TrackFilter::Only(indices) => indices.contains(&index),
        }
    }
}

/// Shift selected tracks by `semitones` (may be negative), in place.
pub fn transpose(song: &mut Song, semitones: i32, filter: &TrackFilter) {
    if semitones == 0 {
        return;
    }
    for (index, track) in song.tracks.iter_mut().enumerate() {
        if !filter.includes(index, track.is_drums) {
            continue;
        }
        for measure in &mut track.measures {
            for voice in &mut measure.voices {
                for beat in &mut voice.beats {
                    for note in &mut beat.notes {
                        note.pitch = (note.pitch as i32 + semitones).clamp(0, 127) as u8;
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Beat, Duration, Measure, Note, Song, TimeSignature, Track, Tuning, Voice};

    fn track(name: &str, is_drums: bool, pitch: u8) -> Track {
        Track {
            name: name.into(),
            instrument: 0,
            tuning: Tuning::default(),
            is_drums,
            measures: vec![Measure {
                voices: vec![Voice {
                    beats: vec![Beat {
                        duration: Duration::new(4),
                        notes: vec![Note {
                            pitch,
                            velocity: 100,
                            bend: None,
                            articulation: Default::default(),
                            tied: false,
                        }],
                    }],
                }],
                time_signature: None,
                tempo: None,
                marker: None,
            }],
        }
    }

    fn first_pitch(track: &Track) -> u8 {
        track.measures[0].voices[0].beats[0].notes[0].pitch
    }

    fn song() -> Song {
        Song {
            title: "t".into(),
            artist: "a".into(),
            tempo: 120.0,
            time_signature: TimeSignature::default(),
            tracks: vec![track("Guitar", false, 60), track("Drums", true, 38)],
        }
    }

    #[test]
    fn exclude_drums_shifts_melodic_but_not_percussion() {
        let mut s = song();
        transpose(&mut s, 5, &TrackFilter::exclude_drums());
        assert_eq!(first_pitch(&s.tracks[0]), 65, "guitar should shift +5");
        assert_eq!(first_pitch(&s.tracks[1]), 38, "drum mapping should be untouched");
    }

    #[test]
    fn all_shifts_every_track() {
        let mut s = song();
        transpose(&mut s, 5, &TrackFilter::All);
        assert_eq!(first_pitch(&s.tracks[0]), 65);
        assert_eq!(first_pitch(&s.tracks[1]), 43);
    }
}
