# Rehearsal

A browser-based screenplay rehearsal app. Write a scene, record the other characters' lines, then rehearse: the app plays each reader line and listens for you to say yours before moving on.

Everything runs locally in the browser. Scripts and recordings are stored in IndexedDB. There is no server and no build step.

## Running

Open `index.html` in a modern browser (Chrome, Edge, Safari or Firefox). Opening it straight from disk works.

The microphone only works on `file://` or `http://localhost`. If you host the app anywhere else, serve it over HTTPS.

**GitHub Pages:** `.github/workflows/pages.yml` deploys `main` on every push. The speech runtimes and models aren't in git, so the workflow downloads and verifies them with `speech-lab/setup.py` before publishing. In the repository's Settings > Pages, set Source to "GitHub Actions".

## Line detection in play mode

The **line detection** menu in the play bar (next to the settings button; it shows the current mode, and is icon-only on phones) chooses how the app decides you've finished a line. These choices are saved for this device, not per script. The settings button keeps Reader spacing.

- **Voice activity (pause)** is the default and needs no setup. Your line ends after a short pause; `(then)` or `(beat)` inside a line marks a pause with more to come.
- **Vosk** or **Sherpa-ONNX speech recognition** listens to the words instead and moves on as soon as it hears the last words of your line (the **cue**). **Cue** sets how many words that is (default 5). These engines need the one-time `python3 speech-lab/setup.py` and the app served by `python3 speech-lab/serve.py`. If an engine can't load, play mode says so and uses voice activity.
- **Shorter lines: use voice activity** is an experiment, off by default. Lines with fewer words than the cue finish on a pause instead of speech recognition.

The engines are loaded on demand from `speech-lab/js/rehearsal-engine.js`, the same code the Tests lab benchmarks.

## Tests

**Tests**, at the top of the sidebar, opens the Speech Recognition Lab (`speech-lab/`) in the main area, the way a script opens. It benchmarks offline speech engines for cue detection. It needs a one-time `python3 speech-lab/setup.py` and a local server (`python3 speech-lab/serve.py`, then open `http://localhost:8000/`). It doesn't work from `file://`. Use `serve.py` rather than `python3 -m http.server`: the plain server sends no cache headers, so browsers can keep running old JavaScript after an update. See `speech-lab/README.md`.

## Script import (first pass)

`script-import/` turns a screenplay PDF, Fountain or Final Draft file into typed blocks
(scene heading, action, character, parenthetical, dialogue, transition) with a confidence for each,
entirely on the device. Choose **Import** at the top of the sidebar and pick a file. An import pane opens:
name the script, choose who you play (**You**, preselected with a best guess), and review the blocks. You can retype, confirm or delete any of
them. **Import** creates the script and opens it; exiting asks first. It needs a local server like Tests
(`python3 speech-lab/serve.py`). A standalone debug view is at `/script-import/`. Tests:
`node script-import/tests/run.js`. Details and known limitations: [script-import/README.md](script-import/README.md).

## Settings

**Settings** sits under Tests at the top of the sidebar. Choices are saved in this browser (`localStorage`).

- **General**
  - **Theme:** a dropdown with System, Light or Dark. System follows the device and updates when it changes.
  - **Microphone:** the microphone's status with **Connect** / **Release**. The microphone uses the browser's default processing (echo cancellation, noise suppression and automatic gain control all on).
- **Install:** installs the app to open in its own window. In Chrome and Edge, an **Install** button shows the browser's install prompt. Safari (iPhone: Share > Add to Home Screen; Mac: File > Add to Dock) and other browsers get instructions instead, and an installed app says so.
- **Storage:** whether this browser has agreed to keep the app's data, and how much it uses. On iPhone, Safari clears a site's data after 7 days without a visit, so add the app to the home screen (Share > Add to Home Screen) and open it from there. The home-screen app has its own storage, separate from the Safari tab. `manifest.webmanifest` and `icons/` make it installable.

The microphone is released when you stop a reader recording, and in play mode when a scene ends or you press Stop.

## Project structure

```
index.html              Markup only; links the stylesheets and scripts below
css/
  tokens.css            Design tokens: shadcn preset b0 plus app tokens (page colour, hover grey, layout sizes)
  base.css              Element resets, inputs, icon sizing, utilities (.hidden, .row, .truncate)
  shadcn.css            shadcn/ui Button, DropdownMenu, Sidebar menu, Popover, Dialog, Tooltip (base-nova)
  layout.css            App shell, sidebar and script library, top bar
  components.css        Where menus and popovers sit; dialog body; play-mode pane
  editor.css            Screenplay editor: blocks, margin tools, record controls, character picker
js/
  icons.js              icon() and renderIcons() helpers built on Lucide
  app.js                App logic: library (IndexedDB), editor, recording, play mode
vendor/
  lucide/               Lucide icon library v1.78.0 (UMD build) and its ISC licence
```

The stylesheets load in the order above. Later files can build on earlier ones.

## Icons

All icons come from [Lucide](https://lucide.dev/icons). Use Lucide's kebab-case names:

- **In HTML:** `<i data-lucide="play"></i>`. The placeholder is swapped for an SVG on startup.
- **In JavaScript:** `button.append(icon('play'))`.

Size icons with CSS. `.lucide` defaults to 16px in `css/base.css`.

To update Lucide, replace `vendor/lucide/lucide.min.js` and `LICENSE` with the same files from the new release's `lucide` npm package (`dist/umd/lucide.min.js`), then update the version above.

## Buttons and menus

Every button, menu and sidebar row uses the shadcn/ui classes in `css/shadcn.css`. They are translated one-to-one from the "base-nova" registry, which is the style of preset b0. Don't add one-off button styles. Pick a variant and a size instead:

| Need | Classes |
|---|---|
| Primary action | `btn btn-default` |
| Secondary action | `btn btn-secondary` |
| Cancel / neutral | `btn btn-outline` |
| Toolbar or icon-only | `btn btn-ghost btn-icon` |
| Dangerous action | `btn btn-destructive` |
| Menu | `dropdown-menu` containing `dropdown-menu-item` (add `data-variant="destructive"` for delete) |
| Sidebar row | `sidebar-menu-button` (+ `data-active`), with a `sidebar-menu-action` for its `⋯` |
| Floating panel | `popover` |
| Confirmation | `dialog-overlay` > `dialog-content` with `dialog-header` / `dialog-footer` |

Sizes: default (32px), `btn-xs`, `btn-sm`, `btn-lg`, `btn-icon`, `btn-icon-xs`, `btn-icon-sm`, `btn-icon-lg`. For an icon beside a label, put `data-icon="inline-start"` on the icon.

## Theme

Colours follow the shadcn preset in `css/tokens.css`. To switch presets, replace the two preset blocks at the top of that file with the values from `https://ui.shadcn.com/init?preset=<code>`. Light and dark mode are applied with `data-theme` on `<html>`. The saved choice (`system`, `light` or `dark`) is in `localStorage` under `rehearsal-theme`.
