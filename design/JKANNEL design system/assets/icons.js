/* JKANNEL icon set — ported verbatim from frontend/src/components/AppIcon.vue.
   24x24, fill:none, stroke:currentColor, stroke-width 1.7, round caps/joins. */
(function () {
  var ICONS = {
  "home": "<path d=\"M3 10.5 12 3l9 7.5\"/><path d=\"M5 9.5V21h14V9.5\"/>",
  "sms": "<path d=\"M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9l-4 3v-3H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z\"/>",
  "queue": "<path d=\"M4 7h16M4 12h16M4 17h10\"/><circle cx=\"19\" cy=\"17\" r=\"2\"/>",
  "check": "<path d=\"M20 6 9 17l-5-5\"/><circle cx=\"12\" cy=\"12\" r=\"9\"/>",
  "chevron": "<path d=\"M6 9l6 6 6-6\"/>",
  "server": "<rect x=\"3\" y=\"4\" width=\"18\" height=\"7\" rx=\"1.6\"/><rect x=\"3\" y=\"13\" width=\"18\" height=\"7\" rx=\"1.6\"/><path d=\"M7 7.5h.01M7 16.5h.01\"/>",
  "route": "<circle cx=\"5\" cy=\"5\" r=\"2\"/><circle cx=\"19\" cy=\"19\" r=\"2\"/><path d=\"M7 5h4a3 3 0 0 1 3 3v8a3 3 0 0 0 3 3M14 10l3-3 3 3\"/>",
  "cog": "<circle cx=\"12\" cy=\"12\" r=\"3\"/><path d=\"M19 12a7 7 0 0 0-.1-1l2-1.5-2-3.4-2.4 1A8 8 0 0 0 15 6l-.3-2.6h-4L10.4 6A8 8 0 0 0 8.8 7L6.4 6l-2 3.4 2 1.5a7 7 0 0 0 0 2.1l-2 1.5 2 3.4 2.4-1A8 8 0 0 0 10.4 18l.3 2.6h4L15 18a8 8 0 0 0 1.6-1l2.4 1 2-3.4-2-1.5a7 7 0 0 0 .1-1z\"/>",
  "chart": "<path d=\"M3 3v18h18\"/><path d=\"M7 14l3-3 3 2 4-6\"/>",
  "alert": "<path d=\"M12 9v4M12 17h.01\"/><path d=\"M10.3 3.9 2 18a2 2 0 0 0 1.7 3h16.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z\"/>",
  "users": "<circle cx=\"9\" cy=\"8\" r=\"3.2\"/><path d=\"M3.5 20a5.5 5.5 0 0 1 11 0M16 5.2a3.2 3.2 0 0 1 0 5.6M17.5 20a5.5 5.5 0 0 0-3-4.9\"/>",
  "api": "<path d=\"M9 15l6-6M10.5 6.5 12 5a4 4 0 0 1 6 6l-1.5 1.5M13.5 17.5 12 19a4 4 0 0 1-6-6l1.5-1.5\"/>",
  "docker": "<rect x=\"3\" y=\"7\" width=\"18\" height=\"13\" rx=\"2\"/><path d=\"M8 3h3v4M13 3h3v4M3 12h18M7 16h.01\"/>",
  "terminal": "<rect x=\"3\" y=\"4\" width=\"18\" height=\"16\" rx=\"2\"/><path d=\"M7 9l3 3-3 3M13 15h4\"/>",
  "plugin": "<path d=\"M8 3h4v4h4V3h3v6h-4v4h4v3h-6v-4H9v4H3v-3h4V9H3V3h3v4h2z\"/>",
  "db": "<ellipse cx=\"12\" cy=\"5\" rx=\"8\" ry=\"3\"/><path d=\"M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6\"/>",
  "shield": "<path d=\"M12 3 4 6v6c0 5 3.5 7.5 8 9 4.5-1.5 8-4 8-9V6z\"/>",
  "search": "<circle cx=\"11\" cy=\"11\" r=\"7\"/><path d=\"m20 20-3.5-3.5\"/>",
  "bell": "<path d=\"M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9\"/><path d=\"M13.7 21a2 2 0 0 1-3.4 0\"/>",
  "sun": "<circle cx=\"12\" cy=\"12\" r=\"4.2\"/><path d=\"M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4\"/>",
  "moon": "<path d=\"M21 12.8A8.5 8.5 0 1 1 11.2 3 6.6 6.6 0 0 0 21 12.8z\"/>",
  "menu": "<path d=\"M4 6h16M4 12h16M4 18h16\"/>",
  "logout": "<path d=\"M10 5H5v14h5M14 8l4 4-4 4M18 12H9\"/>",
  "eye": "<path d=\"M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z\"/><circle cx=\"12\" cy=\"12\" r=\"3\"/>",
  "eyeoff": "<path d=\"M2 12s3.5-7 10-7c2 0 3.7.5 5.2 1.3M22 12s-3.5 7-10 7c-2 0-3.7-.5-5.2-1.3\"/><path d=\"m3 3 18 18\"/>",
  "spark": "<path d=\"M12 3v4M12 17v4M3 12h4M17 12h4M6.3 6.3l2.1 2.1M15.6 15.6l2.1 2.1M17.7 6.3l-2.1 2.1M8.4 15.6l-2.1 2.1\"/><circle cx=\"12\" cy=\"12\" r=\"3\"/>",
  "key": "<circle cx=\"8\" cy=\"15\" r=\"4\"/><path d=\"M10.8 12.2 20 3M17 6l2 2M15 8l2 2\"/>",
  "help": "<circle cx=\"12\" cy=\"12\" r=\"9\"/><path d=\"M9.6 9.2a2.5 2.5 0 1 1 3.3 2.4c-.6.2-.9.8-.9 1.4v.5\"/><path d=\"M12 17h.01\"/>",
  "external": "<path d=\"M14 4h6v6\"/><path d=\"M20 4 11 13\"/><path d=\"M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5\"/>"
};
  function jkIcon(name, size, cls) {
    var body = ICONS[name] || ICONS.cog;
    size = size || 18;
    return '<svg class="' + (cls || 'ico') + '" width="' + size + '" height="' + size +
      '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + body + '</svg>';
  }
  function jkHydrateIcons(root) {
    (root || document).querySelectorAll('[data-ico]').forEach(function (el) {
      el.innerHTML = jkIcon(el.getAttribute('data-ico'), Number(el.getAttribute('data-size')) || 18, el.getAttribute('data-ico-class') || '');
    });
  }
  window.JKANNEL_ICONS = ICONS;
  window.JKANNEL_ICON_NAMES = Object.keys(ICONS);
  window.jkIcon = jkIcon;
  window.jkHydrateIcons = jkHydrateIcons;
  if (document.readyState !== 'loading') jkHydrateIcons();
  else document.addEventListener('DOMContentLoaded', function () { jkHydrateIcons(); });
})();
