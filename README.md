# Rehearsal

A browser-based screenplay rehearsal app. Write a scene, record the other characters' lines, then rehearse: the app plays each reader line and listens for you to say yours before moving on.

Everything runs locally in the browser. Scripts and recordings are stored in IndexedDB. There is no server and no build step.

## Running

Open `index.html` in a modern browser (Chrome, Edge, Safari or Firefox). Opening it straight from disk works.

The microphone only works on `file://` or `http://localhost`. If you host the app anywhere else, serve it over HTTPS.

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

Colours follow the shadcn preset in `css/tokens.css`. To switch presets, replace the two preset blocks at the top of that file with the values from `https://ui.shadcn.com/init?preset=<code>`. Light and dark mode are chosen with `data-theme` on `<html>`, and the choice is saved in `localStorage`.
