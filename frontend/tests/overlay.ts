import { DOMWrapper, type VueWrapper } from '@vue/test-utils';

/**
 * Finding a node that may have been teleported out of the component.
 *
 * `ModalDialog` and `DetailDrawer` both `<Teleport to="body">`, which is what
 * puts an overlay above the page instead of inside the panel that opened it.
 * The consequence for a test is that `wrapper.get(...)` cannot see them: the
 * markup is in `document.body`, not in the mounted subtree.
 *
 * These helpers look in the component first and in the body second, so a test
 * asserts on WHAT is on screen rather than on where in the DOM tree it happens
 * to live — and, importantly, keeps passing either way. A test that hard-codes
 * one location silently starts asserting nothing the day the node moves.
 *
 * `document.body` is cleared before every test in `setup.ts`, so a teleported
 * node from an earlier test cannot be found by a later one.
 */
export function overlay(wrapper: VueWrapper, selector: string): DOMWrapper<Element> {
  const local = wrapper.find(selector);
  if (local.exists()) return local;
  const teleported = document.body.querySelector(selector);
  if (!teleported) throw new Error(`Not found in component or overlay: ${selector}`);
  return new DOMWrapper(teleported);
}

/** Whether the node exists in either place. Never throws. */
export function overlayHas(wrapper: VueWrapper, selector: string): boolean {
  return wrapper.find(selector).exists() || Boolean(document.body.querySelector(selector));
}

/**
 * Every match in both places, for tests that count rather than address.
 *
 * The union, deduplicated by node identity — not "the component's matches, or
 * the body's if there are none". A screen commonly matches a generic selector
 * in both at once (a `th` in the register AND a `th` in the open sheet), and
 * preferring one side silently hid the sheet's rows from the count.
 *
 * The dedupe matters because Vue Test Utils mounts into `document.body`, so a
 * node inside the component is reachable from both queries.
 */
export function overlayAll(wrapper: VueWrapper, selector: string): DOMWrapper<Element>[] {
  const seen = new Set<Element>();
  const out: DOMWrapper<Element>[] = [];
  for (const found of wrapper.findAll(selector)) {
    seen.add(found.element);
    out.push(found);
  }
  for (const el of document.body.querySelectorAll(selector)) {
    if (seen.has(el)) continue;
    seen.add(el);
    out.push(new DOMWrapper(el));
  }
  return out;
}
