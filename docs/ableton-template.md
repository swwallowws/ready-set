# Building the transpose-macro Live template (SPEC §8, Option B)

Goal: a tiny Live set with one MIDI track whose **Pitch** device (transpose) is
mapped to a **rack Macro**, plus a few notes. You build it once by hand; then we
`gunzip` it to learn the `.als` schema and have the exporter (Option A) generate
this structure automatically.

**Keep it minimal:** one MIDI track and ~3 notes. The smaller the set, the
smaller and more readable the XML, which makes templating far easier.

## Steps (Ableton Live 11 / 12)

1. **New set.** File → New Live Set. Press **Tab** to make sure you can see
   tracks; you'll see a couple of default MIDI/Audio tracks.

2. **Trim to one MIDI track.** Delete everything except a single MIDI track
   (right-click a track header → Delete). You want exactly one MIDI track.

3. **Rename it.** Select the track, press **Cmd/Ctrl+R**, type `Guitar`.

4. **Add the Pitch device.** Open the Browser (left), go to **MIDI Effects →
   Pitch**, and drag **Pitch** onto the track. (Show the Device View at the
   bottom with **Shift+Tab** if it's hidden.) The Pitch device has a main
   **Pitch** knob; that's the transpose (±48 semitones).

5. **Wrap it in a MIDI Effect Rack.** ⚠️ Group the **device**, not the track.
   In the Device View, **click the Pitch device's title bar** so the *device* is
   selected, then **Cmd/Ctrl+G**. It becomes a **MIDI Effect Rack** containing
   Pitch, still on the same track.
   - If a new indented track header appears in your track list instead, you
     grouped the *track* and made a **Group Track** (an audio bus with no
     devices/macros, which is the wrong thing). Undo (`Cmd/Ctrl+Z`) and group the device.

6. **Map Pitch → Macro 1.** Right-click the Pitch device's **Pitch** knob →
   **Map to Macro 1** (Live 12) / **Map to Macro** (Live 11). Macro 1 appears on
   the rack automatically (no need to add anything else; macros are part of the
   rack). Optionally rename Macro 1 to `Transpose`. Turning Macro 1 now
   transposes the track.

6b. **(Optional) MIDI-map Macro 1 to a CC.** This shows us how Live stores a
   MIDI-CC→parameter binding, which the exporter reuses for "one knob transposes
   every track." Press **Cmd/Ctrl+M**, click **Macro 1**, then move a knob on a
   MIDI controller (or any CC source); a CC label appears on the macro. Press
   **Cmd/Ctrl+M** again to exit. Skip this if you have no controller; we can add
   the CC binding in the exporter afterward.

7. **Add a few notes.** In Session view, double-click a clip slot on the track
   to create an empty clip, then draw **3 notes** in the piano roll (e.g. C3,
   E3, G3, each a quarter). This lets us see the embedded-note format too.

8. **Save the set.** **Cmd/Ctrl+S** → name it `transpose-template.als`. (Use a plain
   Save rather than "Save as Template", so everything lives in one `.als` file.)

9. **Decompress and share.** In a terminal:

    ```sh
    gunzip -c /path/to/transpose-template.als > transpose-template.xml
    ```

    Share `transpose-template.xml` (paste it, or drop it in `fixtures/`). Also
    tell me your **Live version** (Live → About Live) so the exporter targets
    the right schema.

## What this gives the exporter

From your file we read the exact element names/nesting for: the `MidiTrack`, the
MIDI Effect Rack wrapping the Pitch device, the **Macro → Pitch parameter
mapping**, the **MidiClip note format**, and (if you did step 6b) the
**MIDI-CC → Macro binding**. The exporter then generates one such track per
instrument (vocals excluded), notes embedded, and gzips it to `.als`, and can
bind every track's Macro 1 to one shared CC for one-knob-rules-all transpose.
