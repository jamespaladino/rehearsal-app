# Script import fixtures

## Real scripts: drop them in `fixtures/real/`

Put real screenplay files here (`.pdf`, `.fountain`, `.fdx`) to check the importer against them.
The folder is git-ignored, so scripts you don't have the rights to share never get committed.

Then look at the result, block by block:

- **Browser (any OS, any Node):** run `python3 speech-lab/serve.py` from the repository root,
  open <http://localhost:8000/script-import/>, and choose the file.
- **Command line:** `node script-import/cli.js script-import/fixtures/real/my-script.pdf`
  (PDFs need Node 20+; Fountain and FDX work on any Node).
  Add `--review` to print only blocks flagged for review, or `--json` for the full result.

Useful scripts to try: ones from different software (Final Draft, WriterSolo, Highland,
Fade In, Celtx, Word templates), shooting scripts with scene numbers, (MORE)/(CONT'D) and
revision asterisks, scripts with dual dialogue, and a scanned PDF (should be flagged, not read).

## Synthetic fixtures: `fixtures/synthetic/`

Small files made for the tests. The PDFs are generated from `scenes.js` by
`node script-import/fixtures/make-fixtures.js` (rerun it after changing `scenes.js`).

| File | Covers |
|---|---|
| `normal-scene.pdf` | every block type, scene numbers in both margins, a revision asterisk, an extension (O.S.) |
| `page-break.pdf` | dialogue split by a page break with (MORE) / BEN (CONT'D), an action sentence cut by a page break, page numbers |
| `dual-dialogue.pdf` | side-by-side dialogue, including a parenthetical in the right column |
| `beat.pdf` | (beat) inside a speech and at the start of one |
| `transitions.pdf` | FADE IN:, SMASH CUT TO:, DISSOLVE TO:, FADE OUT. |
| `title-page-shifted.pdf` | a title page, a running header, page numbers, and all margins shifted by 0.25" |
| `night-drive.fountain` | Fountain: title page, scene numbers, extensions, (beat), dual dialogue (^), forced elements, notes, boneyard |
| `night-drive.fdx` | Final Draft: paragraph types, DualDialogue, scene numbers, styled text runs, XML entities, title page |
