import { BadRequestException } from '@nestjs/common';
import { AlertLifecycleController } from './alert-lifecycle.controller';

const ALERT_ID = '11111111-1111-4111-8111-111111111111';
const request: any = { principal: { tenantId: '1', userId: 'u1', username: 'ops' } };

function controllerWith() {
  const repository: any = {
    acknowledge: jest.fn(async () => ({ id: ALERT_ID, status: 'acknowledged' })),
    resolve: jest.fn(async () => ({ id: ALERT_ID, status: 'resolved' })),
    assign: jest.fn(async () => ({ id: ALERT_ID, assignedTo: 'u9' })),
    suppress: jest.fn(async () => ({ id: ALERT_ID, suppressedUntil: 'later' })),
    reopen: jest.fn(async () => ({ id: ALERT_ID, status: 'open' })),
    close: jest.fn(async () => ({ id: ALERT_ID, status: 'closed' })),
    addComment: jest.fn(async () => ({ id: 'c1' })),
    listComments: jest.fn(async () => []),
    get: jest.fn(async () => ({ id: ALERT_ID })),
  };
  return { controller: new AlertLifecycleController(repository), repository };
}

describe('AlertLifecycleController', () => {
  it('forwards the acting principal, including the username, to the repository', async () => {
    const { controller, repository } = controllerWith();
    await controller.acknowledge(request, ALERT_ID, { note: 'on it' });
    expect(repository.acknowledge).toHaveBeenCalledWith(
      { tenantId: '1', userId: 'u1', username: 'ops' },
      ALERT_ID,
      'on it',
    );
  });

  it('rejects a non-UUID alert id on every route', () => {
    const { controller } = controllerWith();
    expect(() => controller.resolve(request, 'not-a-uuid', {})).toThrow(BadRequestException);
    expect(() => controller.reopen(request, 'not-a-uuid', {})).toThrow(BadRequestException);
    expect(() => controller.listComments(request, 'not-a-uuid')).toThrow(BadRequestException);
  });

  it('requires an assignee', () => {
    const { controller } = controllerWith();
    expect(() => controller.assign(request, ALERT_ID, {})).toThrow(BadRequestException);
    expect(() => controller.assign(request, ALERT_ID, { assignee: '   ' })).toThrow(
      BadRequestException,
    );
  });

  it('requires a positive suppression window', () => {
    const { controller } = controllerWith();
    expect(() => controller.suppress(request, ALERT_ID, { minutes: 0 })).toThrow(
      BadRequestException,
    );
    expect(() => controller.suppress(request, ALERT_ID, { minutes: 'soon' })).toThrow(
      BadRequestException,
    );
  });

  it('passes the suppression window and reason through', async () => {
    const { controller, repository } = controllerWith();
    await controller.suppress(request, ALERT_ID, { minutes: 30, reason: 'planned work' });
    expect(repository.suppress).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: '1' }),
      ALERT_ID,
      30,
      'planned work',
    );
  });

  it('requires a comment body and trims it', async () => {
    const { controller, repository } = controllerWith();
    expect(() => controller.addComment(request, ALERT_ID, { body: '' })).toThrow(
      BadRequestException,
    );
    await controller.addComment(request, ALERT_ID, { body: '  checked  ' });
    expect(repository.addComment).toHaveBeenCalledWith(expect.anything(), ALERT_ID, 'checked');
  });

  it('exposes the comment history and the lifecycle view', async () => {
    const { controller, repository } = controllerWith();
    await controller.listComments(request, ALERT_ID);
    await controller.lifecycle(request, ALERT_ID);
    expect(repository.listComments).toHaveBeenCalled();
    expect(repository.get).toHaveBeenCalled();
  });
});
