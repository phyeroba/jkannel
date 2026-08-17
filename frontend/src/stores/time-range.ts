import { computed, ref } from 'vue';

/**
 * One time range, shared by every analytical screen (spec §2.1, §6).
 *
 * §6's UI requirement is specific and is the reason this is a store rather than
 * per-screen state: *"Preserve selected time range when navigating between
 * Traffic, SMSC and Diagnostics."* An operator investigating an incident picks
 * a window once — the fifteen minutes around the drop — and every screen they
 * open next has to answer for that same window. Re-picking it on each screen is
 * how two panels end up describing different hours and an incident gets
 * misread.
 */
export interface RangePreset {
  id: string;
  label: string;
  minutes: number;
}

/**
 * Short windows first, because §17.2 says operational dashboards default short
 * and analytical views retain selectable history. 24h is the default: long
 * enough to contain a shift, short enough that the figures are about now.
 */
export const RANGE_PRESETS: RangePreset[] = [
  { id: '15m', label: 'Last 15 minutes', minutes: 15 },
  { id: '1h', label: 'Last hour', minutes: 60 },
  { id: '6h', label: 'Last 6 hours', minutes: 360 },
  { id: '24h', label: 'Last 24 hours', minutes: 1440 },
  { id: '7d', label: 'Last 7 days', minutes: 10080 },
  { id: '30d', label: 'Last 30 days', minutes: 43200 },
];

const DEFAULT_PRESET = '24h';
const STORAGE_KEY = 'jkannel-console-time-range';

const presetId = ref<string>(readStoredPreset());

function readStoredPreset(): string {
  try {
    const stored = sessionStorage.getItem(STORAGE_KEY);
    return RANGE_PRESETS.some((preset) => preset.id === stored)
      ? (stored as string)
      : DEFAULT_PRESET;
  } catch {
    // Private-mode browsers throw on sessionStorage; a default is fine here.
    return DEFAULT_PRESET;
  }
}

/**
 * sessionStorage, not localStorage, and the distinction is deliberate. A time
 * range is incident-scoped: it should survive a reload in the middle of an
 * investigation and NOT still be "last 15 minutes" when the operator opens the
 * console fresh next week and reads a nearly-empty dashboard as an outage.
 */
export function setRangePreset(id: string): void {
  if (!RANGE_PRESETS.some((preset) => preset.id === id)) return;
  presetId.value = id;
  try {
    sessionStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* Not persisting is survivable; failing the interaction is not. */
  }
}

export const selectedRange = computed(
  () => RANGE_PRESETS.find((preset) => preset.id === presetId.value) ?? RANGE_PRESETS[3],
);

/**
 * The window as absolute instants, resolved at call time.
 *
 * Deliberately NOT a stored `from`/`to` pair: a relative window that is
 * recomputed on each request keeps following the clock, which is what "last 15
 * minutes" means to an operator watching a recovery. Freezing it at selection
 * would silently turn a live window into a historical one.
 */
export function resolveWindow(now: number = Date.now()): { from: Date; to: Date; minutes: number } {
  const minutes = selectedRange.value.minutes;
  return { from: new Date(now - minutes * 60_000), to: new Date(now), minutes };
}

/** Days, for the several report endpoints that take a `days` parameter. */
export const rangeDays = computed(() => Math.max(1, Math.ceil(selectedRange.value.minutes / 1440)));
