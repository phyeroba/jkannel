import { computed, ref } from 'vue';
import type { RouteLocationNormalizedLoaded } from 'vue-router';

/**
 * Breadcrumbs that preserve the operational hierarchy (spec §2.1) — e.g.
 * `Carriers / MTN Uganda / MTN-P1 / TRX-02`.
 *
 * The console's breadcrumbs were an array of static strings on the route's
 * `meta`, with only "Home" as a link. That is enough for a flat workspace list
 * and useless for the drill-down the specification is built around: the whole
 * point of Carrier → SMSC → Session is that an operator three levels deep can
 * see where they are and step back out one level at a time.
 *
 * A route cannot supply this on its own, because the middle segments are entity
 * NAMES that are only known once the entity has loaded. So a view publishes its
 * trail when it has the data, and the shell renders whatever is current.
 */
export interface Crumb {
  label: string;
  /** Omit on the final segment: the page you are on is not a link to itself. */
  to?: string;
}

const dynamicTrail = ref<Crumb[] | null>(null);
/**
 * The path the trail was published for. Guards against a stale trail from the
 * previous screen being rendered under the next one — the failure that makes
 * breadcrumbs actively misleading rather than merely unhelpful.
 */
const trailPath = ref<string | null>(null);

/**
 * Publish a hierarchy for the current route. Call it once the entity is loaded;
 * calling it with a placeholder name first is worse than leaving the static
 * fallback in place, because the crumb would visibly change under the reader.
 */
export function setBreadcrumbTrail(path: string, crumbs: Crumb[]): void {
  trailPath.value = path;
  dynamicTrail.value = crumbs;
}

/** Drop any published trail. The shell calls this on every navigation. */
export function clearBreadcrumbTrail(): void {
  dynamicTrail.value = null;
  trailPath.value = null;
}

/**
 * The trail to render: the published hierarchy when it belongs to this route,
 * otherwise the route's own static `meta.breadcrumb`.
 *
 * Static crumbs stay unlinked, exactly as before — inventing hrefs for them
 * would produce links to routes that may not exist.
 */
export function resolveBreadcrumbs(route: RouteLocationNormalizedLoaded): Crumb[] {
  if (dynamicTrail.value && trailPath.value === route.path) return dynamicTrail.value;
  const meta = route.meta.breadcrumb;
  return Array.isArray(meta) ? meta.map((label) => ({ label: String(label) })) : [];
}

/** Exposed for tests and for the shell's watcher. */
export const hasDynamicTrail = computed(() => dynamicTrail.value !== null);
