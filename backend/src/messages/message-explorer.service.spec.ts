import { MessageExplorerService } from './message-explorer.service';
describe('MessageExplorerService', () => {
  const service = new MessageExplorerService();
  const records = [
    {
      id: '1',
      tenantId: 'a',
      direction: 'MT' as const,
      sender: 'x',
      recipient: 'y',
      status: 'sent',
      smscId: 's1',
      createdAt: new Date(1),
    },
    {
      id: '2',
      tenantId: 'b',
      direction: 'MT' as const,
      sender: 'x',
      recipient: 'y',
      status: 'sent',
      smscId: 's1',
      createdAt: new Date(2),
    },
  ];
  it('enforces tenant isolation before filtering', () =>
    expect(service.filter('a', records, { status: 'sent' }).map((x) => x.id)).toEqual(['1']));
  it('rejects inverted time ranges', () =>
    expect(() => service.filter('a', records, { from: new Date(2), to: new Date(1) })).toThrow(
      'Invalid time range',
    ));
});
