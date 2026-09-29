//! Model → Standard MIDI File via [`midly`] (SPEC §5).
//!
//! The two pieces of "core mapping math" from the spec live here as standalone,
//! tested functions:
//!
//! * [`note_number`]: `open_string_pitch + fret`.
//! * [`duration_to_ticks`]: note value → MIDI ticks, adjusted for dots and
//!   tuplets.
//!
//! Layout: a conductor track (tempo + time signature, including mid-song
//! changes) followed by one track per instrument. General MIDI channels are
//! assigned in order; drum tracks are forced onto channel 10 (index 9).
//!
//! v1 scope: correct notes at correct times + tempo/time-sig. Articulations
//! and ties are carried in the model but not yet rendered (SPEC §5).

use midly::{
    num::{u15, u24, u28, u4, u7},
    Format, Header, MetaMessage, MidiMessage, PitchBend, Smf, Timing, TrackEvent, TrackEventKind,
};

use crate::model::{Duration, Song, TimeSignature, Track};

/// Pulses (ticks) per quarter note. 480 is a common, divisible default.
pub const DEFAULT_TPQ: u16 = 480;

/// MIDI channel reserved for percussion (channel 10, zero-indexed 9).
const DRUM_CHANNEL: u8 = 9;

/// MIDI note number for an open string plus a fret offset, saturating at the
/// 0–127 MIDI range.
///
/// ```
/// # use tabridge::midi::note_number;
/// assert_eq!(note_number(40, 0), 40); // open low E
/// assert_eq!(note_number(40, 5), 45); // 5th fret = A
/// ```
pub fn note_number(open_string_pitch: u8, fret: u8) -> u8 {
    open_string_pitch.saturating_add(fret).min(127)
}

/// Convert a beat [`Duration`] (a fraction of a whole note) to MIDI ticks.
///
/// A whole note is four quarters = `4 * tpq`, so a fraction `num/denom` of it
/// is `num * 4 * tpq / denom`. Dots and tuplets are already folded into the
/// fraction (see [`Duration`]), so no extra adjustment is needed here.
///
/// ```
/// # use tabridge::midi::duration_to_ticks;
/// # use tabridge::model::Duration;
/// assert_eq!(duration_to_ticks(Duration::new(4), 480), 480); // quarter
/// assert_eq!(duration_to_ticks(Duration::new(8), 480), 240); // eighth
/// assert_eq!(duration_to_ticks(Duration::new(4).dotted(1), 480), 720);
/// assert_eq!(duration_to_ticks(Duration::new(4).tuplet(3, 2), 480), 320);
/// ```
pub fn duration_to_ticks(duration: Duration, tpq: u32) -> u32 {
    let denom = duration.denominator.max(1) as u64;
    (duration.numerator as u64 * 4 * tpq as u64 / denom) as u32
}

/// Render a [`Song`] to Standard MIDI File bytes.
pub fn write_midi(song: &Song) -> Result<Vec<u8>, String> {
    let tpq = DEFAULT_TPQ as u32;

    let header = Header::new(Format::Parallel, Timing::Metrical(u15::new(DEFAULT_TPQ)));
    let mut tracks: Vec<Vec<TrackEvent>> = Vec::with_capacity(song.tracks.len() + 1);

    tracks.push(build_conductor_track(song, tpq));

    let mut next_channel: u8 = 0;
    for track in &song.tracks {
        let channel = if track.is_drums {
            DRUM_CHANNEL
        } else {
            if next_channel == DRUM_CHANNEL {
                next_channel += 1;
            }
            let c = next_channel.min(15);
            next_channel += 1;
            c
        };
        tracks.push(build_instrument_track(track, channel, tpq));
    }

    let smf = Smf { header, tracks };
    let mut buf = Vec::new();
    smf.write_std(&mut buf).map_err(|e| e.to_string())?;
    Ok(buf)
}

/// (absolute tick, sort key, event). Lower sort keys fire first within a tick:
/// 0 = meta/program, 1 = note-off, 2 = note-on (so a note ending and another
/// starting on the same tick don't clip).
type AbsEvent<'a> = (u32, u8, TrackEventKind<'a>);

/// Build the conductor track: initial tempo + time signature, plus any
/// per-measure changes (timed off the first instrument track, which all parts
/// are assumed to share a bar grid with).
fn build_conductor_track<'a>(song: &'a Song, tpq: u32) -> Vec<TrackEvent<'a>> {
    let mut events: Vec<AbsEvent> = Vec::new();
    events.push((0, 0, tempo_event(song.tempo)));
    events.push((0, 0, time_sig_event(song.time_signature)));

    if let Some(track) = song.tracks.first() {
        // Use the shared renderer's bar grid so tempo/time-sig changes land on
        // the same measure boundaries as the notes (no drift).
        let (measure_starts, _) = crate::render::track_events(track);
        for (i, measure) in track.measures.iter().enumerate() {
            let tick = (measure_starts[i] * tpq as f64).round() as u32;
            if tick > 0 {
                if let Some(bpm) = measure.tempo {
                    events.push((tick, 0, tempo_event(bpm)));
                }
                if let Some(ts) = measure.time_signature {
                    events.push((tick, 0, time_sig_event(ts)));
                }
            }
        }
    }

    finalize(events)
}

/// Build one instrument track: name, program (unless drums), then notes.
fn build_instrument_track<'a>(track: &'a Track, channel: u8, tpq: u32) -> Vec<TrackEvent<'a>> {
    let chan = u4::new(channel);
    let mut events: Vec<AbsEvent> = Vec::new();

    events.push((
        0,
        0,
        TrackEventKind::Meta(MetaMessage::TrackName(track.name.as_bytes())),
    ));

    if !track.is_drums {
        events.push((
            0,
            0,
            TrackEventKind::Midi {
                channel: chan,
                message: MidiMessage::ProgramChange { program: u7::new(track.instrument.min(127)) },
            },
        ));
        // Widen the pitch-bend range to ±48 semitones (RPN 0) so bends/slides
        // of any size render accurately and match the .als MPE range.
        let cc = |num: u8, val: u8| TrackEventKind::Midi {
            channel: chan,
            message: MidiMessage::Controller { controller: u7::new(num), value: u7::new(val) },
        };
        for (num, val) in [(101, 0), (100, 0), (6, PITCH_BEND_RANGE), (38, 0)] {
            events.push((0, 0, cc(num, val)));
        }
    }

    // Note timing, tie-merging, dead/staccato shortening and velocity all come
    // from the shared renderer (beats); convert to ticks here.
    let (_, sounding) = crate::render::track_events(track);
    for ev in sounding {
        let key = u7::new(ev.pitch.min(127));
        let vel = u7::new(ev.velocity.min(127));
        let on = (ev.start * tpq as f64).round() as u32;
        let off = on + (ev.dur * tpq as f64).round().max(1.0) as u32;
        events.push((on, 2, TrackEventKind::Midi { channel: chan, message: MidiMessage::NoteOn { key, vel } }));
        events.push((off, 1, TrackEventKind::Midi { channel: chan, message: MidiMessage::NoteOff { key, vel: u7::new(0) } }));
        if let Some(fx) = ev.pitch_fx {
            push_pitch_fx(&mut events, chan, on, off, ev.dur, fx, tpq);
        }
    }

    finalize(events)
}

/// Pitch-bend range we configure per channel (semitones), matching the .als
/// MPE range so bend/slide depths are consistent across outputs.
const PITCH_BEND_RANGE: u8 = 48;

/// Emit a pitch-bend curve for one note from [`render::pitch_curve`], then reset
/// to 0 at release. Pitch-bend is per-channel (MIDI limitation), so this affects
/// every note sounding on the track at the time; the `.als` MPE path is
/// per-note instead.
fn push_pitch_fx(events: &mut Vec<AbsEvent>, channel: u4, on: u32, off: u32, dur_beats: f64, fx: crate::render::PitchFx, tpq: u32) {
    let bend = |frac: f32| TrackEventKind::Midi {
        channel,
        message: MidiMessage::PitchBend { bend: PitchBend::from_f32(frac.clamp(-1.0, 1.0)) },
    };
    for (offset_beats, semitones) in crate::render::pitch_curve(fx, dur_beats) {
        let tick = (on + (offset_beats * tpq as f64).round() as u32).min(off);
        events.push((tick, 0, bend(semitones / PITCH_BEND_RANGE as f32)));
    }
    events.push((off, 0, bend(0.0)));
}

fn tempo_event<'a>(bpm: f64) -> TrackEventKind<'a> {
    let us_per_quarter = if bpm > 0.0 { (60_000_000.0 / bpm) as u32 } else { 500_000 };
    TrackEventKind::Meta(MetaMessage::Tempo(u24::new(us_per_quarter)))
}

fn time_sig_event<'a>(ts: TimeSignature) -> TrackEventKind<'a> {
    // MIDI encodes the denominator as a power of two (4 → 2, 8 → 3, …).
    let denom_pow = ts.denominator.max(1).trailing_zeros() as u8;
    TrackEventKind::Meta(MetaMessage::TimeSignature(ts.numerator, denom_pow, 24, 8))
}

/// Sort absolute-timed events and convert to delta-timed [`TrackEvent`]s,
/// appending an end-of-track meta event.
fn finalize(mut events: Vec<AbsEvent>) -> Vec<TrackEvent> {
    events.sort_by_key(|(tick, order, _)| (*tick, *order));

    let mut out = Vec::with_capacity(events.len() + 1);
    let mut prev_tick = 0u32;
    for (tick, _, kind) in events {
        let delta = tick - prev_tick;
        prev_tick = tick;
        out.push(TrackEvent { delta: u28::new(delta), kind });
    }
    out.push(TrackEvent { delta: u28::new(0), kind: TrackEventKind::Meta(MetaMessage::EndOfTrack) });
    out
}
