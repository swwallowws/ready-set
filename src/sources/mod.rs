//! The extensibility seam: every tab provider implements [`Source::load`],
//! turning user input into the normalized [`Song`](crate::model::Song).
//!
//! Every source is handed an [`Http`] client, so it contains **no**
//! platform/networking specifics: the same code runs against a native client,
//! an edge-WASI client, or a browser proxy (SPEC §6) by swapping the injected
//! [`Http`]. Sources that read self-contained documents (e.g. [`MusicXml`])
//! ignore the network and just parse their input.

pub mod guitarpro;
pub mod musicxml;

pub use guitarpro::GuitarPro;
pub use musicxml::MusicXml;

use crate::model::Song;

/// Platform-agnostic HTTP GET, the IO seam for [`Source`] implementations.
///
/// Implementors return the **decompressed** response body (clients are
/// expected to transparently inflate gzip, as browsers do).
pub trait Http {
    fn get(&self, url: &str) -> Result<Vec<u8>, SourceError>;
}

/// A fetcher that performs no IO: for pure/offline paths where the caller
/// supplies the page/payloads directly (e.g. the browser-proxy WASM bindings
/// or tests). Any actual `get` is an error.
#[derive(Debug, Default, Clone, Copy)]
pub struct NoHttp;

impl Http for NoHttp {
    fn get(&self, url: &str) -> Result<Vec<u8>, SourceError> {
        Err(SourceError::Fetch(format!(
            "no HTTP client configured (a fetch of {url} was attempted)"
        )))
    }
}

/// Anything that can go wrong resolving or fetching a source.
#[derive(Debug)]
pub enum SourceError {
    /// The input URL / query was not understood by this source.
    UnrecognizedInput(String),
    /// A network request failed.
    Fetch(String),
    /// Payload could not be parsed into the model.
    Parse(String),
    /// Reached a code path that is still stubbed.
    NotImplemented(&'static str),
}

impl std::fmt::Display for SourceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SourceError::UnrecognizedInput(s) => write!(f, "unrecognized input: {s}"),
            SourceError::Fetch(s) => write!(f, "fetch failed: {s}"),
            SourceError::Parse(s) => write!(f, "parse failed: {s}"),
            SourceError::NotImplemented(s) => write!(f, "not implemented: {s}"),
        }
    }
}

impl std::error::Error for SourceError {}

/// A tab provider. Implementors live under this module (e.g. [`MusicXml`],
/// [`GuitarPro`]) and turn `input` (a URL, file content, or raw document) into a
/// normalized [`Song`], using `http` for any network lookups they need.
pub trait Source {
    fn load(&self, input: &str, http: &dyn Http) -> Result<Song, SourceError>;
}
