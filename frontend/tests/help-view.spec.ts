import { mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { ref } from 'vue';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/stores/session', () => ({
  session: ref({
    displayName: 'Amina Operator',
    roleLabel: 'NOC',
    // Deliberately narrow: /smsc and /users must not be offered as deep links.
    permissions: new Set(['dashboard.view', 'messages.view', 'reports.view']),
  }),
  canAccess: (value: { permissions: Set<string> } | null, permission?: string) =>
    !permission || Boolean(value?.permissions.has(permission)),
}));

import HelpView from '../src/views/HelpView.vue';
import { documentationUrl, userGuides } from '../src/navigation';

const mountHelp = async () => {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:pathMatch(.*)*', component: { template: '<p>body</p>' } }],
  });
  await router.push('/help');
  await router.isReady();
  return mount(HelpView, { global: { plugins: [router] } });
};

describe('in-app documentation', () => {
  it('links out to the hosted guides safely and lists every one of them', async () => {
    const wrapper = await mountHelp();

    const openGuides = wrapper.get('[data-testid="help-open-guides"]');
    expect(openGuides.attributes('href')).toBe(documentationUrl);
    expect(openGuides.attributes('target')).toBe('_blank');
    expect(openGuides.attributes('rel')).toBe('noopener noreferrer');

    for (const guide of userGuides) {
      const row = wrapper.get(`[data-testid="guide-${guide.number}"]`);
      expect(row.text()).toContain(guide.title);
      expect(row.text()).toContain(guide.purpose);
      const link = row.get('a');
      expect(link.attributes('href')).toBe(guide.url);
      // Every outbound link opens in a new tab and cannot reach back in.
      expect(link.attributes('target')).toBe('_blank');
      expect(link.attributes('rel')).toBe('noopener noreferrer');
    }
  });

  it('shows a first-run sequence and only deep-links screens the role may open', async () => {
    const wrapper = await mountHelp();
    const steps = wrapper.get('[data-testid="help-steps"]');
    expect(steps.findAll('li')).toHaveLength(6);
    expect(steps.text()).toContain('Take the console tour');

    const internalTargets = wrapper
      .findAll('a')
      .map((link) => link.attributes('href') ?? '')
      .filter((href) => href !== '' && !href.startsWith('http'));
    // dashboard.view / messages.view / reports.view only.
    expect(internalTargets).toContain('/dashboard/operations');
    expect(internalTargets).toContain('/reports');
    expect(internalTargets).not.toContain('/smsc');
    expect(internalTargets).not.toContain('/users');
  });
});
