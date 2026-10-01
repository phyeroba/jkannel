<script setup lang="ts">
import { computed } from 'vue';
const props = withDefaults(defineProps<{ name: string; size?: number }>(), { size: 18 });
const icons: Record<string, string> = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/>',
  sms: '<path d="M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9l-4 3v-3H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"/>',
  queue: '<path d="M4 7h16M4 12h16M4 17h10"/><circle cx="19" cy="17" r="2"/>',
  check: '<path d="M20 6 9 17l-5-5"/><circle cx="12" cy="12" r="9"/>',
  // Points down when a section is expanded; the nav rotates it when collapsed.
  chevron: '<path d="M6 9l6 6 6-6"/>',
  server:
    '<rect x="3" y="4" width="18" height="7" rx="1.6"/><rect x="3" y="13" width="18" height="7" rx="1.6"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  route:
    '<circle cx="5" cy="5" r="2"/><circle cx="19" cy="19" r="2"/><path d="M7 5h4a3 3 0 0 1 3 3v8a3 3 0 0 0 3 3M14 10l3-3 3 3"/>',
  cog: '<circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1l2-1.5-2-3.4-2.4 1A8 8 0 0 0 15 6l-.3-2.6h-4L10.4 6A8 8 0 0 0 8.8 7L6.4 6l-2 3.4 2 1.5a7 7 0 0 0 0 2.1l-2 1.5 2 3.4 2.4-1A8 8 0 0 0 10.4 18l.3 2.6h4L15 18a8 8 0 0 0 1.6-1l2.4 1 2-3.4-2-1.5a7 7 0 0 0 .1-1z"/>',
  chart: '<path d="M3 3v18h18"/><path d="M7 14l3-3 3 2 4-6"/>',
  // Scheduled Sends: a message being held for a future instant.
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
  alert:
    '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 2 18a2 2 0 0 0 1.7 3h16.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
  users:
    '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 20a5.5 5.5 0 0 1 11 0M16 5.2a3.2 3.2 0 0 1 0 5.6M17.5 20a5.5 5.5 0 0 0-3-4.9"/>',
  api: '<path d="M9 15l6-6M10.5 6.5 12 5a4 4 0 0 1 6 6l-1.5 1.5M13.5 17.5 12 19a4 4 0 0 1-6-6l1.5-1.5"/>',
  docker:
    '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 3h3v4M13 3h3v4M3 12h18M7 16h.01"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M13 15h4"/>',
  plugin: '<path d="M8 3h4v4h4V3h3v6h-4v4h4v3h-6v-4H9v4H3v-3h4V9H3V3h3v4h2z"/>',
  db: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
  shield: '<path d="M12 3 4 6v6c0 5 3.5 7.5 8 9 4.5-1.5 8-4 8-9V6z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  bell: '<path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
  sun: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A8.5 8.5 0 1 1 11.2 3 6.6 6.6 0 0 0 21 12.8z"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  logout: '<path d="M10 5H5v14h5M14 8l4 4-4 4M18 12H9"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
  eyeoff:
    '<path d="M2 12s3.5-7 10-7c2 0 3.7.5 5.2 1.3M22 12s-3.5 7-10 7c-2 0-3.7-.5-5.2-1.3"/><path d="m3 3 18 18"/>',
  spark:
    '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6.3 6.3l2.1 2.1M15.6 15.6l2.1 2.1M17.7 6.3l-2.1 2.1M8.4 15.6l-2.1 2.1"/><circle cx="12" cy="12" r="3"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M10.8 12.2 20 3M17 6l2 2M15 8l2 2"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.2a2.5 2.5 0 1 1 3.3 2.4c-.6.2-.9.8-.9 1.4v.5"/><path d="M12 17h.01"/>',
  external:
    '<path d="M14 4h6v6"/><path d="M20 4 11 13"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v4.5h-4.5"/>',

  /*
   * ONE ICON PER NAVIGATION ENTRY.
   *
   * Fifty entries were drawing sixteen icons between them: `route` served
   * Routing, Advanced Routing, Inbound Routing and Failover; `alert` served
   * Alerts, Alert Lifecycle and SMPP Errors; `bell` served Escalation,
   * Notifications and Events. A sidebar icon exists to let someone find a
   * row without reading it, and four identical glyphs in one group do the
   * opposite — they make the labels the only way to tell the rows apart,
   * while taking the space that would have made the labels bigger.
   *
   * All stroke-only on the same 24x24 grid as the set above, so they sit at
   * one weight beside the originals.
   */
  lifecycle:
    '<path d="M4 12a8 8 0 0 1 13.7-5.6"/><path d="M20 12a8 8 0 0 1-13.7 5.6"/><path d="M18 3v4h-4"/><path d="M6 21v-4h4"/>',
  escalate: '<path d="M4 20h4v-5H4z"/><path d="M10 20h4V10h-4z"/><path d="M16 20h4V5h-4z"/>',
  activity: '<path d="M2 12h4l3 8 4-16 3 8h6"/>',
  report:
    '<path d="M6 3h8l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v4h4"/><path d="M9 17v-3M12 17v-6M15 17v-4"/>',
  gauge:
    '<path d="M4 18a8 8 0 1 1 16 0"/><path d="M12 18l4.5-6"/><circle cx="12" cy="18" r="1.4"/>',
  filter: '<path d="M3 5h18l-7 8v6l-4 2v-8z"/>',
  inbound: '<path d="M21 12H8"/><path d="M12 7l-5 5 5 5"/><path d="M3 4v16"/>',
  branch:
    '<circle cx="6" cy="5" r="2.4"/><circle cx="6" cy="19" r="2.4"/><circle cx="18" cy="12" r="2.4"/><path d="M6 7.4v9.2"/><path d="M8.4 5h3.6a3 3 0 0 1 3 3v1.6"/>',
  failover:
    '<path d="M3 8h7a4 4 0 0 1 4 4v0a4 4 0 0 0 4 4h3"/><path d="M18 13l3 3-3 3"/><path d="M3 16h5" stroke-dasharray="2 2"/>',
  bug: '<path d="M8 7a4 4 0 0 1 8 0"/><rect x="7" y="7" width="10" height="11" rx="5"/><path d="M3 11h4M17 11h4M3 17h4M17 17h4M12 7V4"/>',
  stream:
    '<path d="M4 7h10M4 12h16M4 17h7"/><circle cx="18" cy="7" r="2"/><circle cx="14" cy="17" r="2"/>',
  receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>',
  retry: '<path d="M4 12a8 8 0 1 1 2.3 5.7"/><path d="M4 20v-4.5h4.5"/><path d="M12 8v4l3 2"/>',
  tower:
    '<path d="M12 10v11"/><path d="M8 21h8"/><circle cx="12" cy="7" r="2"/><path d="M7.5 11A6 6 0 0 1 7.5 3"/><path d="M16.5 11a6 6 0 0 0 0-8"/>',
  archive:
    '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><path d="M10 12h4"/>',
  plug: '<path d="M9 3v6M15 3v6"/><path d="M7 9h10v3a5 5 0 0 1-10 0z"/><path d="M12 17v4"/>',
  nodes:
    '<circle cx="12" cy="5" r="2.2"/><circle cx="5" cy="19" r="2.2"/><circle cx="19" cy="19" r="2.2"/><path d="M12 7.2 6.4 16.8M12 7.2l5.6 9.6M7.2 19h9.6"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7L11.5 7"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 18.7l1.5-1.4"/>',
  book: '<path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v16H6.5A2.5 2.5 0 0 0 4 20.5z"/><path d="M4 20.5A2.5 2.5 0 0 1 6.5 18H20v4H6.5A2.5 2.5 0 0 1 4 19.5z"/>',
  ledger:
    '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 3v18"/><path d="M12 8h5M12 12h5M12 16h3"/>',
  flask:
    '<path d="M10 3h4"/><path d="M11 3v6L5.5 18.5A2 2 0 0 0 7.2 21h9.6a2 2 0 0 0 1.7-2.5L13 9V3"/><path d="M8.5 15h7"/>',
  sliders:
    '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
  bulk: '<rect x="3" y="7" width="13" height="10" rx="2"/><path d="M7 4h11a3 3 0 0 1 3 3v9"/><path d="M6 11h7M6 14h4"/>',
  target:
    '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3.5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
  inbox:
    '<path d="M3 13h5l1.5 3h5L16 13h5"/><path d="M5 5h14l2 8v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-5z"/>',
  id: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="11" r="2.2"/><path d="M5.8 16.2a3.6 3.6 0 0 1 6.4 0"/><path d="M15 10h4M15 14h3"/>',
  jobs: '<circle cx="12" cy="12" r="8"/><path d="M12 7.5V12l3 1.8"/><path d="M19.5 5.5 21 4M4.5 5.5 3 4"/>',
};
const content = computed(() => icons[props.name] ?? icons.cog);
</script>
<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.7"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    v-html="content"
  ></svg>
</template>
