import { mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ref } from 'vue';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/stores/session', () => ({
  session: ref({
    displayName: 'Amina Operator',
    roleLabel: 'NOC',
    permissions: new Set([
      'dashboard.view',
      'messages.view',
      'smsc.view',
      'routes.view',
      'configuration.view',
      'monitoring.view',
      'alerts.view',
      'reports.view',
      'users.view',
      'users.sessions',
      'system.view',
    ]),
  }),
  canAccess: (value: { permissions: Set<string> } | null, permission?: string) =>
    !permission || Boolean(value?.permissions.has(permission)),
  logout: vi.fn(),
}));

import AppShell from '../src/layouts/AppShell.vue';

const STORAGE_KEY = 'jkannel-console-nav-collapsed';

const routeStub = (path: string) => ({
  path,
  component: { template: '<p>body</p>' },
  meta: { title: path, description: '', breadcrumb: [] },
});

const mountShell = async (path = '/dashboard/operations') => {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      routeStub('/dashboard/operations'),
      routeStub('/messages'),
      routeStub('/reports'),
      routeStub('/help'),
    ],
  });
  await router.push(path);
  await router.isReady();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
  return mount(AppShell, { global: { plugins: [router] }, attachTo: document.body });
};

const groupLinks = (wrapper: ReturnType<typeof mount>, group: string) =>
  wrapper.findAll(`#nav-group-${group.toLowerCase()} a`);

describe('primary navigation default state and persistence', () => {
  it('starts a first visit with only Overview expanded', async () => {
    // No stored preference at all.
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    const wrapper = await mountShell();

    expect(groupLinks(wrapper, 'Overview').length).toBeGreaterThan(0);
    expect(wrapper.find('#nav-group-messaging').exists()).toBe(false);
    expect(wrapper.find('#nav-group-customers').exists()).toBe(false);
    expect(wrapper.find('#nav-group-platform').exists()).toBe(false);
    expect(
      wrapper.get('[data-testid="nav-group-toggle-messaging"]').attributes('aria-expanded'),
    ).toBe('false');
    expect(
      wrapper.get('[data-testid="nav-group-toggle-overview"]').attributes('aria-expanded'),
    ).toBe('true');
  });

  it('respects a pre-v2 preference, including "nothing collapsed"', async () => {
    // The legacy representation was a bare array of collapsed group names, so
    // an empty array is a deliberate "everything open" — not "no preference".
    localStorage.setItem(STORAGE_KEY, '[]');
    const wrapper = await mountShell();
    for (const group of ['overview', 'messaging', 'customers', 'platform'])
      expect(wrapper.find(`#nav-group-${group}`).exists()).toBe(true);
  });

  it('respects a pre-v2 preference that names collapsed groups', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(['Customers']));
    const wrapper = await mountShell();
    expect(wrapper.find('#nav-group-messaging').exists()).toBe(true);
    expect(wrapper.find('#nav-group-customers').exists()).toBe(false);
  });

  it('persists a toggle in the v2 shape so the next visit is not a first visit', async () => {
    const wrapper = await mountShell();
    await wrapper.get('[data-testid="nav-group-toggle-overview"]').trigger('click');
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual({
      version: 2,
      collapsed: [
        'Connectivity',
        'Traffic',
        'Routing',
        'Diagnostics',
        'System',
        'Messaging',
        'Customers',
        'Platform',
        'Overview',
      ],
    });

    await wrapper.get('[data-testid="nav-group-toggle-messaging"]').trigger('click');
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).collapsed).not.toContain('Messaging');
    expect(groupLinks(wrapper, 'Messaging').length).toBeGreaterThan(0);
  });

  it('keeps the group owning the active route expanded', async () => {
    // /messages lives in Messaging, which the first-visit default collapses.
    const wrapper = await mountShell('/messages');
    expect(wrapper.find('#nav-group-messaging').exists()).toBe(true);
    expect(
      wrapper.findAll('#nav-group-messaging a').some((link) => link.text().includes('Messages')),
    ).toBe(true);

    // And it follows navigation, not just the initial render.
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 2, collapsed: ['Insights'] }));
    const second = await mountShell('/reports');
    expect(second.find('#nav-group-customers').exists()).toBe(true);
  });
});

/**
 * A collapsed group must be exactly as tall as its header.
 *
 * jsdom does not lay out, so height cannot be measured — but the three things
 * that produced the residual slab can each be asserted, and together they are
 * the whole of it:
 *
 *  1. the nav is a flex child stretched to the sidebar's height, and a grid
 *     taller than its rows distributes the surplus into them unless
 *     `align-content: start`;
 *  2. the header used to carry the vertical rhythm as a margin, which survived
 *     collapsing;
 *  3. the items were hidden with `v-show`, leaving a grid track (and therefore
 *     a gap) in place.
 */
describe('collapsed navigation group occupies only its header', () => {
  const css = (file: string) => readFileSync(resolve(process.cwd(), 'src', file), 'utf8');

  function applyStylesheets() {
    const style = document.createElement('style');
    // Same order as main.ts: design-authority.css refines style.css.
    style.textContent = `${css('style.css')}\n${css('design-authority.css')}`;
    document.head.append(style);
  }

  it('leaves no residual height once a group is collapsed', async () => {
    applyStylesheets();
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 2, collapsed: [] }));
    const wrapper = await mountShell();

    const nav = wrapper.get('aside[aria-label="Primary navigation"] nav').element;
    const messaging = wrapper
      .findAll('.nav-group')
      .find((group) => group.text().startsWith('Messaging'))!;

    // (1) surplus height is not shared out among the groups.
    expect(getComputedStyle(nav).alignContent).toBe('start');
    expect(getComputedStyle(messaging.element).alignContent).toBe('start');

    // (2) the header contributes no margin of its own.
    const header = messaging.get('.nav-label').element;
    const margins = getComputedStyle(header);
    expect([
      margins.marginTop,
      margins.marginBottom,
      margins.marginLeft,
      margins.marginRight,
    ]).toEqual(['0px', '0px', '0px', '0px']);

    // Expanded: header + items, separated by the group's row gap.
    expect(messaging.element.children).toHaveLength(2);

    await wrapper.get('[data-testid="nav-group-toggle-messaging"]').trigger('click');

    // (3) collapsed: the items are gone, not merely hidden, so the group is a
    // single grid track — one row, no gap, no margin: exactly the header.
    expect(messaging.element.children).toHaveLength(1);
    expect(messaging.get('.nav-label').element).toBe(header);
    expect(residualHeight(messaging.element)).toBe(0);
  });

  /**
   * Everything a group contributes beyond its header, in CSS pixels: the row
   * gaps actually rendered (n-1 of them) plus every child's vertical margins.
   */
  function residualHeight(group: Element): number {
    const rows = group.children.length;
    // jsdom does not expand the `gap` shorthand into rowGap; read the shorthand.
    const gap = Number.parseFloat(getComputedStyle(group).gap || '0') || 0;
    let total = rows > 1 ? gap * (rows - 1) : 0;
    for (const child of Array.from(group.children)) {
      const box = getComputedStyle(child);
      total += Number.parseFloat(box.marginTop || '0') || 0;
      total += Number.parseFloat(box.marginBottom || '0') || 0;
    }
    // The header itself is the baseline, so only extra rows count as height.
    return total;
  }
});
