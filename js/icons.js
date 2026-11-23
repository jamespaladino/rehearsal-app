/*
 * Icon helpers built on the vendored Lucide library (vendor/lucide/lucide.min.js).
 *
 * - Static markup: write <i data-lucide="icon-name"></i>; renderIcons() swaps each
 *   placeholder for the matching inline SVG.
 * - Dynamic UI: icon('icon-name') returns a ready-made <svg> element.
 *
 * Icon names are Lucide's kebab-case names (see https://lucide.dev/icons).
 * Size icons with CSS (.lucide defaults to 16px in css/base.css).
 */
(function () {
  'use strict';

  if (!window.lucide) {
    throw new Error('Lucide failed to load: check vendor/lucide/lucide.min.js');
  }

  const toPascalCase = (name) => name.replace(/(^|-)([a-z0-9])/g, (_, __, c) => c.toUpperCase());

  window.icon = function icon(name) {
    const node = lucide.icons[toPascalCase(name)];
    if (!node) throw new Error('Unknown Lucide icon: ' + name);
    return lucide.createElement(node, {
      class: 'lucide lucide-' + name,
      'aria-hidden': 'true',
      focusable: 'false',
    });
  };

  window.renderIcons = function renderIcons(root = document) {
    lucide.createIcons({ icons: lucide.icons, root });
  };
})();
