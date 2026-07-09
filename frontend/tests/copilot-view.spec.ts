import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import CopilotView from '../src/views/CopilotView.vue';

const apiResponse = (data: unknown, status = 200) =>
  Promise.resolve(
    new Response(
      JSON.stringify(status < 400 ? { success: true, data } : { success: false, message: data }),
      { status },
    ),
  );

const toolsPayload = {
  tools: [
    { name: 'queue_depth', description: 'Read current SQLBox queue depth.' },
    { name: 'recent_alerts', description: 'List the most recent alert instances.' },
  ],
};

const answerPayload = {
  answer: 'Queue depth is 4 messages and the engine is healthy.',
  provider: 'anthropic',
  model: 'claude-opus',
  citations: ['reports/volume snapshot 2026-07-08'],
  toolsRun: [
    { tool: 'queue_depth', ok: true, note: 'queried SQLBox' },
    { tool: 'recent_alerts', ok: true },
  ],
  question: 'How deep is the queue?',
  createdAt: '2026-07-09T06:00:00Z',
};

describe('AI Operations Copilot view', () => {
  it('sends a question with the opt-in header and renders the answer, badge, and citations', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/ai/copilot/tools')) return apiResponse(toolsPayload);
      if (url.includes('/ai/copilot') && init?.method === 'POST') return apiResponse(answerPayload);
      return apiResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);

    const wrapper = mount(CopilotView);
    await vi.waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/ai/copilot/tools'))).toBe(
        true,
      ),
    );

    await wrapper.get('[data-testid="copilot-optin-dismiss"]').trigger('click');
    await wrapper.get('[data-testid="copilot-question"]').setValue('How deep is the queue?');
    await wrapper.get('[data-testid="copilot-send"]').trigger('click');

    await vi.waitFor(() =>
      expect(wrapper.get('[data-testid="copilot-answer"]').text()).toContain(
        'Queue depth is 4 messages',
      ),
    );

    const postCall = fetchMock.mock.calls.find(
      (call) =>
        String(call[0]).endsWith('/ai/copilot') &&
        (call[1] as RequestInit | undefined)?.method === 'POST',
    );
    expect(postCall).toBeTruthy();
    const headers = new Headers((postCall?.[1] as RequestInit).headers);
    expect(headers.get('x-jkannel-ai-opt-in')).toBe('true');
    expect(JSON.parse(String((postCall?.[1] as RequestInit).body))).toEqual({
      question: 'How deep is the queue?',
    });

    expect(wrapper.get('[data-testid="copilot-provider"]').text()).toContain('anthropic');
    expect(wrapper.get('[data-testid="copilot-provider"]').text()).toContain('claude-opus');
    const citations = wrapper.findAll('[data-testid="copilot-citation"]');
    expect(citations.length).toBe(2);
    expect(citations[0].text()).toContain('queue_depth');
    expect(wrapper.text()).toContain('Read-only, advisory response');
  });

  it('surfaces an honest message when AI Operations is disabled', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/ai/copilot/tools')) return apiResponse('AI Operations is disabled', 400);
      if (url.includes('/ai/copilot') && init?.method === 'POST')
        return apiResponse('AI Operations is disabled', 400);
      return apiResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);

    const wrapper = mount(CopilotView);
    await vi.waitFor(() =>
      expect(wrapper.find('[data-testid="copilot-disabled"]').exists()).toBe(true),
    );
    expect(wrapper.get('[data-testid="copilot-send"]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-testid="copilot-question"]').attributes('disabled')).toBeDefined();
  });
});
