//! The normalized internal score model.
//!
//! Every `Source` (Guitar Pro, MusicXML, …) parses into this same
//! tree, and every output target (MIDI now, ALS later) reads from it. The
//! hierarchy mirrors the spec: `Song → Track → Measure → Beat → Note`, plus
//! `Tuning`.
//!
//! Pitch convention throughout: MIDI note numbers (middle C = 60, A4 = 69).

use serde::{Deserialize, Serialize};

/// A complete song: global musical context plus one track per instrument.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Song {
    pub title: String,
    pub artist: String,
    /// Initial tempo in beats per minute. Mid-song tempo changes live on
    /// individual measures (see [`Measure::tempo`]).
    pub tempo: f64,
    /// Initial time signature, e.g. `(4, 4)`.
    pub time_signature: TimeSignature,
    pub tracks: Vec<Track>,
}

/// One instrument's part.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Track {
    pub name: String,
    /// General MIDI program number (0–127). Ignored when [`is_drums`] is set.
    ///
    /// [`is_drums`]: Track::is_drums
    pub instrument: u8,
    /// Open-string pitches, for tab-derived tracks (informational/provenance;
    /// pitch already lives on each [`Note`]). Empty for non-fretted sources
    /// like MusicXML and for drum tracks.
    pub tuning: Tuning,
    /// Drum tracks are forced onto MIDI channel 10. (Note pitches are GM
    /// percussion numbers either way; see [`Note::pitch`].)
    pub is_drums: bool,
    pub measures: Vec<Measure>,
}

/// One bar. Holds one or more [`Voice`]s: independent simultaneous rhythmic
/// lines (Guitar Pro models polyphony this way; most tracks use a single voice).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Measure {
    pub voices: Vec<Voice>,
    /// Time-signature change effective from this measure, if any.
    pub time_signature: Option<TimeSignature>,
    /// Tempo change (BPM) effective from this measure, if any.
    pub tempo: Option<f64>,
    /// Section label starting at this measure (e.g. "Verse", "Chorus"), if the
    /// source marks one. Used to split exports into per-section clips.
    pub marker: Option<String>,
}

/// One rhythmic line within a [`Measure`]. All voices in a measure start
/// together at the bar line and play in parallel.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Voice {
    pub beats: Vec<Beat>,
}

/// A rhythmic position holding zero or more simultaneous notes (a chord).
/// An empty `notes` vector is a rest.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Beat {
    pub duration: Duration,
    pub notes: Vec<Note>,
}

/// A single sounding note, as an absolute MIDI pitch.
///
/// Sources compute this however they like: tab sources from
/// `tuning[string] + fret` (see [`crate::midi::note_number`]), MusicXML from
/// `step`/`octave`/`alter`, drums from the GM percussion number, so the rest
/// of the pipeline is source-agnostic.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Note {
    /// MIDI note number, 0–127 (middle C = 60).
    pub pitch: u8,
    /// MIDI velocity, 1–127 (derived from the source's dynamics + accents/ghost).
    pub velocity: u8,
    /// Upward bend target in semitones, if the note bends (rendered as a
    /// pitch-bend ramp). `None` for un-bent notes.
    pub bend: Option<f32>,
    /// Articulations. Some affect rendering now ([`Articulation::dead`],
    /// `staccato` shorten the note); the rest are retained for higher-fidelity
    /// export later (slides/vibrato/harmonics; see SPEC §5).
    pub articulation: Articulation,
    /// Tied from the previous note of the same pitch: the prior note is held
    /// through this one rather than re-attacking.
    pub tied: bool,
}

/// Open-string MIDI pitches, lowest string first. Standard guitar EADGBE is
/// `[40, 45, 50, 55, 59, 64]`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct Tuning(pub Vec<u8>);

impl Tuning {
    /// Standard 6-string guitar: E2 A2 D3 G3 B3 E4.
    pub fn standard_guitar() -> Self {
        Tuning(vec![40, 45, 50, 55, 59, 64])
    }

    /// Standard 4-string bass: E1 A1 D2 G2.
    pub fn standard_bass() -> Self {
        Tuning(vec![28, 33, 38, 43])
    }

    /// Open-string pitch for the given string index, if present.
    pub fn open_pitch(&self, string: u8) -> Option<u8> {
        self.0.get(string as usize).copied()
    }
}

/// Beat duration as a rational fraction of a **whole note**
/// (`numerator / denominator`).
///
/// Dots and tuplets are folded into the fraction (see [`Duration::dotted`] and
/// [`Duration::tuplet`]). A quarter note is `1/4`, a dotted eighth `3/16`, an eighth triplet `1/12`.
/// Conversion to ticks is then just `num * 4 * tpq / denom` (see
/// [`crate::midi::duration_to_ticks`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Duration {
    pub numerator: u32,
    pub denominator: u32,
}

impl Duration {
    /// A plain note value: `new(4)` = a quarter = `1/4`.
    pub fn new(note_value: u32) -> Self {
        Duration::from_fraction(1, note_value)
    }

    /// A whole note (`1/1`).
    pub fn whole() -> Self {
        Duration::from_fraction(1, 1)
    }

    /// An arbitrary fraction of a whole note, reduced to lowest terms.
    pub fn from_fraction(numerator: u32, denominator: u32) -> Self {
        let d = denominator.max(1);
        let g = gcd(numerator.max(1), d);
        Duration { numerator: (numerator / g).max(1), denominator: d / g }
    }

    /// Apply `dots` augmentation dots. One dot multiplies length by `3/2`, two
    /// by `7/4`, i.e. by `(2^(dots+1) - 1) / 2^dots`.
    pub fn dotted(self, dots: u8) -> Self {
        if dots == 0 {
            return self;
        }
        let factor = 1u32 << dots; // 2^dots
        Duration::from_fraction(self.numerator * (factor * 2 - 1), self.denominator * factor)
    }

    /// Apply a tuplet: `n` notes in the time of `m` (e.g. `tuplet(3, 2)` for a
    /// triplet), scaling length by `m/n`.
    pub fn tuplet(self, n: u32, m: u32) -> Self {
        if n == 0 {
            return self;
        }
        Duration::from_fraction(self.numerator * m, self.denominator * n)
    }
}

fn gcd(a: u32, b: u32) -> u32 {
    if b == 0 { a.max(1) } else { gcd(b, a % b) }
}

/// Time signature: `numerator` beats of `denominator`-value each.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct TimeSignature {
    pub numerator: u8,
    pub denominator: u8,
}

impl TimeSignature {
    pub fn new(numerator: u8, denominator: u8) -> Self {
        TimeSignature { numerator, denominator }
    }
}

impl Default for TimeSignature {
    fn default() -> Self {
        TimeSignature::new(4, 4)
    }
}

/// Per-note articulation. `dead`/`staccato` shorten the rendered note and
/// `ghost`/`accent` already fold into [`Note::velocity`]; the rest are retained
/// for later pitch-bend / fidelity work (SPEC §5).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct Articulation {
    pub bend: bool,
    pub slide: bool,
    pub hammer_on: bool,
    pub pull_off: bool,
    pub harmonic: bool,
    pub palm_mute: bool,
    /// Dead/muted "X" note, rendered as a short percussive click.
    pub dead: bool,
    /// Ghost (quiet) note, folded into velocity.
    pub ghost: bool,
    /// Staccato: rendered shorter than its written value.
    pub staccato: bool,
    /// Accented, folded into velocity.
    pub accent: bool,
    /// Vibrato: rendered as a pitch oscillation.
    pub vibrato: bool,
}
