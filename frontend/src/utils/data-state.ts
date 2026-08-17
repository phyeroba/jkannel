/**
 * The eight UI states the Kamex UI specification (§17) requires every data
 * surface to be able to express, and the rules for rendering them.
 *
 * This exists because the console already gets these mostly right, ad hoc, in
 * about twenty places — each with its own wording, its own class names and its
 * own idea of what to show while loading. Ad hoc is fine until a new screen
 * quietly renders `0` for a figure it has not fetched yet, at which point an
 * operator reads a real number that was never measured.
 */
export type DataState =
  | 'loading'
  | 'live'
  | 'stale'
  | 'empty'
  | 'partial'
  | 'error'
  | 'in-progress'
  | 'permission-denied';

/** States in which the underlying figures must NOT be presented as fact. */
const UNTRUSTWORTHY: ReadonlySet<DataState> = new Set<DataState>([
  'loading',
  'error',
  'permission-denied',
]);

/**
 * The single most important rule in §17: *"Loading — skeletons for cards and
 * tables; do not show zero values that look real."*
 *
 * A metric tile bound to `count ?? 0` renders a confident `0` before its
 * request resolves, and `0 queued` is a perfectly plausible reading for a
 * healthy gateway. The operator cannot tell it apart from a measurement. This
 * returns the em dash the design system reserves for "no value" instead.
 *
 * `stale` and `partial` deliberately DO pass the value through: those states
 * have a real measurement behind them, just an old or incomplete one, and
 * blanking a NOC screen is worse than a number a few seconds old.
 */
export function displayValue(
  value: number | string | null | undefined,
  state: DataState,
  format?: (value: number) => string,
): string {
  if (UNTRUSTWORTHY.has(state)) return '—';
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '—';
    return format ? format(value) : value.toLocaleString();
  }
  return value;
}

/** Whether a figure rendered in this state is a measurement the operator can act on. */
export const isMeasured = (state: DataState): boolean => !UNTRUSTWORTHY.has(state);

export interface StateCopy {
  /** Short line shown in place of content. */
  title: string;
  /** Optional sentence explaining the cause or the next useful action. */
  detail?: string;
  /** `alert` for states an operator must notice; `status` for the rest. */
  role: 'alert' | 'status';
  tone: 'neutral' | 'warning' | 'danger';
}

export interface StateCopyOptions {
  /** What is missing, lower case and plural: "alerts", "queued messages". */
  subject: string;
  /** Overrides the generated sentence. Prefer this to a generic default. */
  detail?: string;
  /** Age of the last successful reading, for `stale`. */
  ageSeconds?: number | null;
  /** Permission the caller lacks, for `permission-denied`. */
  permission?: string | null;
  /** Which parts could not be loaded, for `partial`. */
  missing?: string[];
}

/**
 * Default copy per state.
 *
 * Every default names the SUBJECT and says something an operator can act on.
 * "No data" is not an acceptable empty state — §17 asks empty to "explain why
 * no data exists and next useful action", and the design system's own voice
 * guide says an empty state is never dressed up but is never blank either.
 */
export function describeState(state: DataState, options: StateCopyOptions): StateCopy {
  const { subject, detail } = options;
  switch (state) {
    case 'loading':
      return { title: `Loading ${subject}…`, detail, role: 'status', tone: 'neutral' };
    case 'empty':
      return {
        title: `No ${subject} recorded.`,
        detail,
        role: 'status',
        tone: 'neutral',
      };
    case 'stale': {
      const age =
        options.ageSeconds === null || options.ageSeconds === undefined
          ? 'some time'
          : `${options.ageSeconds}s`;
      return {
        title: `Showing ${subject} from ${age} ago.`,
        detail:
          detail ??
          'The last refresh did not succeed, so these figures are historical rather than current.',
        role: 'alert',
        tone: 'warning',
      };
    }
    case 'partial':
      return {
        title: `Some ${subject} could not be loaded.`,
        detail:
          detail ??
          (options.missing?.length
            ? `Unavailable: ${options.missing.join(', ')}. Everything else on this screen was read successfully.`
            : 'The rest of this screen was read successfully.'),
        role: 'alert',
        tone: 'warning',
      };
    case 'error':
      return {
        title: `${subject.charAt(0).toUpperCase()}${subject.slice(1)} could not be loaded.`,
        detail,
        role: 'alert',
        tone: 'danger',
      };
    case 'in-progress':
      return { title: detail ?? 'Working…', role: 'status', tone: 'neutral' };
    case 'permission-denied':
      return {
        title: `You do not have permission to view ${subject}.`,
        // Names the permission but nothing about the data behind it — §17 asks
        // for the requirement to be explained "without revealing sensitive data".
        detail: options.permission
          ? `This screen requires the ${options.permission} permission.`
          : 'Ask an administrator which role grants access to this screen.',
        role: 'status',
        tone: 'neutral',
      };
    case 'live':
    default:
      return { title: '', role: 'status', tone: 'neutral' };
  }
}
