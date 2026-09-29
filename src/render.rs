//! Turn a [`Track`]'s notated beats into final **sounding notes**, shared by
//! the MIDI and `.als` writers so both behave identically.
//!
//! This is where notation becomes performance:
//! * **Ties** are merged: a tied note extends the held note rather than
//!   re-attacking (across bar lines too), so sustained notes aren't chopped.
//! * **Dead** (muted) and **staccato** notes are shortened.
//! * **Velocity** (from the source's dynamics/accents/ghosts) is carried per
//!   note.
//! * **Bend / slide / vibrato** become a per-note pitch curve ([`PitchFx`]),
//!   which the MIDI and `.als` writers turn into pitch-bend.
//!
//! Times are in beats (quarter note = 1.0); voices play in parallel from each
//! bar line.

use std::collections::HashMap;

use crate::model::Track;

/// A per-note pitch effect, rendered as a pitch-bend curve via [`pitch_curve`].
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum PitchFx {
    /// Bend up by N semitones (rises early, holds).
    Bend(f32),
    /// Glide by N semitones (signed) to the next note's pitch over the note.
    Slide(f32),
    /// Pitch oscillation around the note.
    Vibrato,
}

/// A final sounding note: `start`/`dur` in beats, plus its source measure
/// (for slicing into sections), velocity, and any pitch effect.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Event {
    pub measure: usize,
    pub pitch: u8,
    pub start: f64,
    pub dur: f64,
    pub velocity: u8,
    pub pitch_fx: Option<PitchFx>,
}

/// Shortest rendered note, so dead/staccato shortening can't reach zero.
const MIN_DUR: f64 = 1.0 / 32.0;

/// Expand a [`PitchFx`] into `(time_offset_beats, semitones)` breakpoints
/// relative to the note start. The last value holds to the note end.
pub fn pitch_curve(fx: PitchFx, dur: f64) -> Vec<(f64, f32)> {
    match fx {
        // Rise to target over the first ~60%, then hold.
        PitchFx::Bend(semis) => vec![(0.0, 0.0), (dur * 0.6, semis)],
        // Glide to the target, reaching it near the end.
        PitchFx::Slide(semis) => vec![(0.0, 0.0), (dur * 0.9, semis)],
        // A few cycles of a triangle wave, ±0.4 st, around the note.
        PitchFx::Vibrato => {
            const DEPTH: f32 = 0.4;
            let cycles = (dur * 1.5).round().clamp(1.0, 8.0) as usize;
            let steps = cycles * 4;
            (0..=steps)
                .map(|i| {
                    let phase = i as f32 / 4.0; // quarter-cycles
                    // triangle wave in [-1, 1]
                    let tri = 1.0 - 4.0 * ((phase + 0.25).fract() - 0.5).abs();
                    (dur * i as f64 / steps as f64, DEPTH * tri)
                })
                .collect()
        }
    }
}

/// Render a track to `(measure_start_beats, events)`. `measure_start_beats` has
/// `len = measures + 1`: `[i]` is measure `i`'s start beat, the last entry is
/// the track length.
pub fn track_events(track: &Track) -> (Vec<f64>, Vec<Event>) {
    let mut measure_starts = vec![0.0f64];
    let mut events: Vec<Event> = Vec::new();
    // Active (still-held) note index per pitch, per voice index; persists
    // across bar lines so ties spanning measures merge correctly.
    let mut active: Vec<HashMap<u8, usize>> = Vec::new();
    // Per-voice index of a slide note awaiting its target (the next note).
    let mut pending_slide: Vec<Option<usize>> = Vec::new();
    let mut acc = 0.0f64;
    let mut bar_beats = 4.0f64; // current bar length (4/4 until a signature says otherwise)

    for (mi, measure) in track.measures.iter().enumerate() {
        if let Some(ts) = measure.time_signature {
            bar_beats = ts.numerator as f64 * 4.0 / ts.denominator.max(1) as f64;
        }
        for (vi, voice) in measure.voices.iter().enumerate() {
            if active.len() <= vi {
                active.push(HashMap::new());
                pending_slide.push(None);
            }
            let mut t = acc;
            for beat in &voice.beats {
                let beat_dur = beat.duration.numerator as f64 * 4.0 / beat.duration.denominator.max(1) as f64;
                for note in &beat.notes {
                    // A tie continues the held note of the same pitch.
                    if note.tied {
                        if let Some(&i) = active[vi].get(&note.pitch) {
                            events[i].dur = (t + beat_dur) - events[i].start;
                            // Carry a pitch effect added during the hold (e.g.
                            // vibrato/bend on the tied continuation) onto the
                            // struck note, if it has none yet.
                            if events[i].pitch_fx.is_none() {
                                if let Some(semis) = note.bend {
                                    events[i].pitch_fx = Some(PitchFx::Bend(semis));
                                } else if note.articulation.vibrato {
                                    events[i].pitch_fx = Some(PitchFx::Vibrato);
                                }
                            }
                            // A slide on the held note glides to the next note.
                            if note.articulation.slide {
                                pending_slide[vi] = Some(i);
                            }
                            continue;
                        }
                        // No note to tie from: fall through and attack it.
                    }
                    let mut dur = beat_dur;
                    if note.articulation.dead {
                        dur *= 0.25;
                    } else if note.articulation.staccato {
                        dur *= 0.5;
                    }
                    let idx = events.len();
                    // Resolve a preceding slide to this note's pitch.
                    if let Some(i) = pending_slide[vi].take() {
                        events[i].pitch_fx = Some(PitchFx::Slide(note.pitch as f32 - events[i].pitch as f32));
                    }
                    // This note's pitch effect: explicit bend wins, then slide
                    // (resolved when the next note arrives), then vibrato.
                    let pitch_fx = if let Some(semis) = note.bend {
                        Some(PitchFx::Bend(semis))
                    } else if note.articulation.slide {
                        pending_slide[vi] = Some(idx);
                        None
                    } else if note.articulation.vibrato {
                        Some(PitchFx::Vibrato)
                    } else {
                        None
                    };
                    active[vi].insert(note.pitch, idx);
                    events.push(Event {
                        measure: mi,
                        pitch: note.pitch,
                        start: t,
                        dur: dur.max(MIN_DUR),
                        velocity: note.velocity.max(1),
                        pitch_fx,
                    });
                }
                t += beat_dur;
            }
        }
        // Advance by the bar length from the time signature. Summing the beats
        // instead would let tracks whose beats overrun the bar (e.g. drum flams)
        // drift out of lock with every other track.
        acc += bar_beats;
        measure_starts.push(acc);
    }
    (measure_starts, events)
}
