# Script import

Imports a screenplay (PDF, Fountain or Final Draft `.fdx`) into typed blocks, entirely on the
device: no network calls, no paid services. A first pass: there's a debug view, not a polished
review UI.

## Run it

**Tests** (any Node 16+; no install):

```sh
node script-import/tests/run.js            # all tests
node script-import/tests/run.js stitch     # only tests whose file or name contains "stitch"
```

The end-to-end PDF tests (`tests/pdf.test.js`) need Node 20+ for pdf.js and are skipped on older
Node with a note; everything else, including the classifier and page-break stitching, runs on 16.

**Debug view in the browser** (PDFs work here on any machine):

```sh
python3 speech-lab/serve.py                 # from the repository root
# open http://localhost:8000/ and choose Import in the sidebar,
# or open http://localhost:8000/script-import/ on its own
```

Choose or drop a file to see every block with its type, confidence, metadata and flags. Tick
"Only blocks to review" to see just the flagged ones. Pick your character and press **Save to
Rehearsal** to create a new script in the app. Inside the app, the sidebar updates straight away and
**Open it** opens the new script.

**Debug view on the command line:**

```sh
node script-import/cli.js path/to/script.pdf             # PDFs need Node 20+
node script-import/cli.js path/to/script.fountain --review
node script-import/cli.js path/to/script.fdx --json
node script-import/cli.js path/to/script.pdf --rehearsal --me ANNA
```

Put real scripts in `script-import/fixtures/real/` (git-ignored); see `fixtures/README.md`.

## What it produces

`importScript(file, { pdfjs })` returns an `ImportResult` (documented in `src/model.js`):

- `blocks`: `scene_heading`, `action`, `character`, `parenthetical`, `dialogue`, `transition`.
  Each block has:
  - `text`
  - `confidence` (0–1)
  - `review` (true below 0.6, or when a flag needs a look)
  - `flags`
  - `page`
  - `meta`:
    - `character` on dialogue and parentheticals
    - `extensions` such as `V.O.`, `O.S.` or `CONT'D`
    - `beat` for `(beat)`
    - `dual` (`left` or `right`)
    - `sceneNumber`
    - `revised`
- `characters`: unique names, most speeches first, for the "my character" choice.
- `warnings`: document-level problems, such as scanned pages.

`toRehearsalScript(result, { meCharacter, title })` (`src/convert.js`) turns that into the app's
own script model. Speeches become `me`/`them` turns. A `(beat)` in the middle of a speech becomes
the app's inline `(beat)` pause; one at the start or end becomes a beat block. Other parentheticals
and extensions are kept on the turn as metadata, so the speech engines never try to hear them.

## How the PDF parser works

1. **Extract** (`src/pdf.js`): pdf.js gives each text run with its position. Pages with no text
   layer are detected and flagged.
2. **Rows and segments** (`src/layout.js`): runs are grouped into lines, and split where there's a
   wide gap. That keeps dual dialogue columns, margin scene numbers and revision asterisks apart.
   Indents written as leading spaces are converted to positions.
3. **Clean** (`src/clean.js`): removes the following.
   - Page numbers and repeated running headers/footers.
   - `(CONTINUED)` / `CONTINUED:` markers.
   - Margin scene numbers, kept on the heading.
   - Revision asterisks, kept as `revised`.
4. **Learn the indents** (`src/cluster.js`, `src/rulesets/screenplay.js`): the left edges of all
   lines are clustered for this document, and each cluster is mapped to a role. The mapping uses
   two things:
   - Position relative to the document's own left margin. The standard 1.5" / 2.5" / 3.1" /
     3.7" / right-aligned indents are only priors.
   - What its lines look like: all caps, starting with "(", following a cue, ending in "TO:".
5. **Classify**: a small state machine walks the lines (inside a speech or not) and combines
   each line's role with its text to choose a type and a confidence. Wrapped lines merge into
   blocks.
6. **Stitch page breaks**: `(MORE)` is dropped, and the continuation after `NAME (CONT'D)` joins
   the previous speech (flagged `stitched`). An action sentence cut by a page break is joined.
7. **Dual dialogue**: a line with two cues side by side starts a two-column region, split into a
   left speech then a right speech (flagged `dual_dialogue`). If the columns run together, the
   region is kept as raw text and flagged `dual_dialogue_unparsed` rather than guessed.

Rulesets are pluggable: `parseLayout(pages, { ruleset })` takes any `{ id, name, classify(rows,
ctx) }`, so a stage-play ruleset can be added beside `rulesets/screenplay.js`.

## Files

| Path | What |
|---|---|
| `src/` | The parser. No DOM, no UI; runs in browsers and Node |
| `src/index.js` | `importScript`, `detectFormat`, re-exports |
| `src/fountain.js`, `src/fdx.js` | Fountain and Final Draft importers, same block model |
| `tests/` | `run.js` (a tiny harness for Node 16+) and the `*.test.js` files |
| `test-support/synthetic.js` | Builds synthetic screenplay pages and minimal PDFs for tests and fixtures |
| `fixtures/` | Synthetic fixtures and the generator; `real/` for your own scripts |
| `index.html`, `debug.js`, `debug.css` | Browser debug view |
| `cli.js`, `node-pdfjs.js` | Command-line debug view |

pdf.js 4.10.38 (Apache-2.0) is vendored in `vendor/pdfjs-4.10.38/`. There are no other
dependencies.

## Known limitations

- **No OCR.** Scanned PDFs (no text layer) are detected, flagged and skipped. The Vision
  framework isn't available in a browser. tesseract.js (Apache-2.0) could be added later as an
  on-device fallback, at the cost of roughly 15 MB of language data.
- **Tested on synthetic scripts only.** Real PDFs from different software will turn up cases the
  rules don't cover yet; that's what the debug view is for.
- **Title page detection is heuristic.** Page 1 is treated as a title page when it has no scene
  heading and either looks centred or contains "written by", "draft" and so on.
- **Dual dialogue.** Assumes Final Draft-style columns; other layouts may come out as
  `dual_dialogue_unparsed`.
- **Dialogue wrapping.** Wrapped lines are joined with spaces, so deliberate line breaks inside a
  PDF speech (lyrics, poems) are lost. Hyphenated words split across lines aren't rejoined.
- **Centred text and unusual indents.** Things like "THE END" or a stray note come out as action
  (flagged when the indent matches nothing).
- **Not supported:**
  - Shots, inserts, and "INTERCUT" as distinct types (they import as headings or action).
  - Stage-play formats (the ruleset is pluggable, but there's only the screenplay one).
  - Non-English headings (INT./EXT. only).
- **Mapping into Rehearsal.**
  - Transitions become action, because the app has no transition type.
  - Parentheticals other than beats are stored but not shown.
  - Reader lines arrive without recordings.
- **Node.** The CLI and the PDF tests need Node 20+, because of pdf.js 4.
- **The Import page is the debug view.** It's opened from the sidebar for now; a proper import flow (pick a
  file, confirm the character, review flagged blocks) would replace it.
