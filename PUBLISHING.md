# Publishing Ready Set

Status 2026-09-29: **public** at `swwallowws/ready-set`, published from a
fresh history (one commit of the cleaned tree). The full earlier history,
which still holds the Ableton SDK tarballs, a real-song tab fixture, removed
third-party source code and an old screenshot, stays in the private archive
repo `swwallowws/ready-set-archive`. Do not push that history here.

## Done

- [x] MIT `LICENSE` (Ready Set's own code). `Cargo.toml` already says MIT.
- [x] Third-party licences ship with their files: `third_party/guitarpro/LICENSE`
  (MIT), `shared/vendor/design/fonts/*-OFL.txt` (SIL OFL for Inter Tight and
  Geist Mono).
- [x] Ableton Extensions SDK tarballs untracked and gitignored
  (`extension/vendor/`); `extension/README.md` says to get them from Ableton,
  as ableton-session-notes does. Their licence forbids distributing the SDK
  "outside of your application".
- [x] Real-song tab fixture removed; the tests use self-made data.
- [x] Third-party source code removed. The Ableton extension instead offers a
  neutral hook for local source modules (see `extension/README.md`); nothing
  source-specific ships.
- [x] Guitar Pro tests write their own files, so no third-party tabs are checked in.
- [x] No secrets: searched for keys, tokens, passwords and private keys.
- [x] README describes the file-first flow, sources and their licences.
- [x] **History.** Published from a fresh single-commit history; the old
  history is only in the private archive.
- [x] **`expressive-liveset` is public (2026-09-29).** `Cargo.toml` fetches it
  over HTTPS at rev `034837d`; no SSH key or `git-fetch-with-cli` needed.
- [x] **Demo bassline.** The website's demo roll plays an original one-bar
  drop-D line (chugs, an octave pop, a hammer-on and pull-off, a vibrato
  hold, a pitch dive) in place of the short phrase from a copyrighted song.
  Approved by ear by Bengisu, 2026-09-27.
- [x] **Visibility.** Public.

## Open

- [ ] **Extension release.** Postponed until after the content review and new
  visuals, so Releases is empty for now. The website's "Inside Ableton" button
  links to this repo and says "Extension: coming soon"; point it at
  `https://github.com/swwallowws/ready-set/releases` once a release exists.
- [x] BitMidi and FreeMIDI adapters stay in the code (decided 2026-10-06), off
  by default behind "Include fan-made MIDI (fine for practice, not for
  release)" in both UIs and the README. Ready Set only searches them and links
  the files; it hosts none.
