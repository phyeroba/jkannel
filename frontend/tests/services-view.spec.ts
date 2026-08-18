import { mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { describe, expect, it, vi, afterEach } from 'vitest';

import ServicesView from '../src/views/ServicesView.vue';
import NodesView from '../src/views/NodesView.vue';

const envelope = (data: unknown) =>
  Promise.resolve(new Response(JSON.stringify({ success: true, data }), { status: 200 }));

const router = () =>
  createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }],
  });

const service = (overrides: Record<string, unknown> = {}) => ({
  name: 'bearerbox',
  role: 'Holds the carrier binds',
  state: 'healthy',
  observation: 'probed',
  detail: 'The engine answered its health probe.',
  dependsOn: [],
  affects: [],
  rootCause: null,
  observedAt: '2026-08-18T09:00:00.000Z',
  ...overrides,
});

const board = (services: unknown[], summary: Record<string, unknown> = {}) => ({
  services,
  summary: {
    total: services.length,
    healthy: 0,
    degraded: 0,
    critical: 0,
    unknown: 0,
    worst: 'healthy',
    rootFailures: [],
    statement: 'All components healthy on their last probe.',
    ...summary,
  },
  observedAt: '2026-08-18T09:00:00.000Z',
});

async function mountServices(payload: unknown) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => envelope(payload));
  const instance = mount(ServicesView, { global: { plugins: [router()] } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await instance.vm.$nextTick();
  return instance;
}

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('the services board', () => {
  it('renders an unobserved component as "not observed", not as healthy', async () => {
    const wrapper = await mountServices(
      board(
        [
          service(),
          service({
            name: 'smsbox',
            state: 'unknown',
            observation: 'unobserved',
            detail: 'Not probed: set KAMEX_SENDSMS_URL to have this component watched.',
            observedAt: null,
          }),
        ],
        { healthy: 1, unknown: 1, worst: 'unknown', statement: '1 not observable of 2 components.' },
      ),
    );

    const row = wrapper.find('[data-testid="service-row-smsbox"]');
    expect(row.text()).toContain('not observed');
    expect(row.text()).not.toContain('healthy');
    // And it tells the operator how to start watching it.
    expect(row.text()).toContain('KAMEX_SENDSMS_URL');
  });

  it('counts blind spots in their own column, always visible', async () => {
    const wrapper = await mountServices(board([service()], { healthy: 1, unknown: 0 }));
    // Present even at zero, so the board's silence about a component can never
    // be mistaken for a pass.
    expect(wrapper.find('[data-testid="services-counts"]').text()).toContain('0 not observed');
  });

  it('puts the worst rows first and unobserved above healthy', async () => {
    const wrapper = await mountServices(
      board([
        service({ name: 'database', state: 'healthy' }),
        service({ name: 'smsbox', state: 'unknown', observation: 'unobserved' }),
        service({ name: 'sqlbox', state: 'critical' }),
      ]),
    );
    const names = wrapper
      .findAll('tbody tr')
      .map((row) => row.find('td').text());
    expect(names).toEqual(['sqlbox', 'smsbox', 'database']);
  });

  it('renders the API verdict verbatim rather than recounting client-side', async () => {
    const statement = 'Start with database — nothing upstream explains it.';
    const wrapper = await mountServices(board([service()], { statement, worst: 'critical' }));
    expect(wrapper.find('[data-testid="services-summary"]').text()).toBe(statement);
  });

  it('sends the operator to the dependency when one explains the failure', async () => {
    const wrapper = await mountServices(
      board([
        service({
          name: 'bearerbox',
          state: 'critical',
          dependsOn: ['database'],
          rootCause: 'database',
        }),
        service({ name: 'database', state: 'critical' }),
      ]),
    );
    // bearerbox sorts first (both critical, alphabetical) and is auto-selected.
    expect(wrapper.find('[data-testid="service-advice"]').text()).toContain('Fix database first');
  });

  it('offers no restart control, because the backend cannot restart anything', async () => {
    const wrapper = await mountServices(board([service()]));
    // §1.1: no control that does not map to something the backend honours.
    expect(wrapper.text()).not.toMatch(/\bRestart\b/);
    expect(wrapper.find('[data-testid="services-no-restart"]').text()).toContain(
      'no Docker socket',
    );
  });
});

describe('the nodes view', () => {
  const nodes = (overrides: Record<string, unknown> = {}) => ({
    items: [
      {
        name: 'jkannel-backend',
        role: 'API and console backend',
        scope: 'container',
        memory: { usedBytes: 268435456, limitBytes: 536870912, percent: 50 },
        cpu: { usageMicros: 5000, limitCores: 1, percent: null },
        process: {
          uptimeSeconds: 3720,
          rssBytes: 268435456,
          heapUsedBytes: 100000000,
          heapTotalBytes: 150000000,
        },
        unavailableReason: null,
        notMeasured: ['Host CPU, memory, disk and load — the backend has no host agent'],
        pressure: 'No resource is under material pressure in this container.',
        observedAt: '2026-08-18T09:00:00.000Z',
      },
    ],
    inventoryComplete: false,
    inventoryLimit: 'This is the only node JKANNEL can measure.',
    notMeasured: ['Host CPU, memory, disk and load — the backend has no host agent'],
    observedAt: '2026-08-18T09:00:00.000Z',
    ...overrides,
  });

  async function mountNodes(payload: unknown) {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => envelope(payload));
    const instance = mount(NodesView, { global: { plugins: [router()] } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await instance.vm.$nextTick();
    return instance;
  }

  it('says up front that one row is not an inventory', async () => {
    const wrapper = await mountNodes(nodes());
    // A one-row Nodes table with no caption reads as "this deployment has one
    // host", which is a claim about the estate that nobody verified.
    expect(wrapper.find('[data-testid="nodes-inventory-limit"]').text()).toContain(
      'only node JKANNEL can measure',
    );
  });

  it('shows "unknown" for a CPU rate it does not have yet, not 0%', async () => {
    const wrapper = await mountNodes(nodes());
    expect(wrapper.find('[data-testid="node-cpu"]').text()).toContain('unknown');
    expect(wrapper.find('[data-testid="node-memory"]').text()).toContain('50%');
  });

  it('renders what is not measured as content, with the reason', async () => {
    const wrapper = await mountNodes(nodes());
    const panel = wrapper.find('[data-testid="nodes-not-measured"]');
    expect(panel.text()).toContain('no host agent');
    expect(panel.text()).toContain('not observable');
  });

  it('explains an unreadable container instead of blanking the screen', async () => {
    const payload = nodes();
    (payload.items[0] as any).unavailableReason = 'cgroup v2 accounting is not present.';
    (payload.items[0] as any).scope = 'process-only';
    const wrapper = await mountNodes(payload);
    expect(wrapper.find('[data-testid="node-unavailable"]').text()).toContain('cgroup v2');
    // The process figures are real and stay on screen.
    expect(wrapper.text()).toContain('1h 2m');
  });
});
