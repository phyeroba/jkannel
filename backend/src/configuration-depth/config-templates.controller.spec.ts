import { BadRequestException } from '@nestjs/common';
import { ConfigTemplatesController } from './config-templates.controller';

const request: any = { principal: { tenantId: '7', userId: 'user-1' } };
const validId = '11111111-1111-4111-8111-111111111111';

describe('ConfigTemplatesController', () => {
  const repository: any = {
    listTemplates: jest.fn(),
    getTemplate: jest.fn(),
    createTemplate: jest.fn(),
    updateTemplate: jest.fn(),
    deleteTemplate: jest.fn(),
  };
  const controller = () => new ConfigTemplatesController(repository);
  beforeEach(() => jest.clearAllMocks());

  it('requires a name on create', () => {
    expect(() => controller().create(request, { content: {} })).toThrow(BadRequestException);
    expect(repository.createTemplate).not.toHaveBeenCalled();
  });

  it('requires a content object on create', () => {
    expect(() => controller().create(request, { name: 'T', content: 'nope' })).toThrow(
      BadRequestException,
    );
  });

  it('rejects an unsupported engine', () => {
    expect(() =>
      controller().create(request, { name: 'T', engine: 'hylafax', content: {} }),
    ).toThrow(BadRequestException);
  });

  it('normalizes a valid create into the actor + input shape', async () => {
    repository.createTemplate.mockResolvedValue({ id: validId, name: 'T' });
    await controller().create(request, {
      name: '  Gateway  ',
      description: '  starter  ',
      engine: 'kamex',
      content: { adminPort: 13000 },
    });
    expect(repository.createTemplate).toHaveBeenCalledWith(
      { tenantId: '7', userId: 'user-1' },
      expect.objectContaining({
        name: 'Gateway',
        description: 'starter',
        engine: 'kamex',
        content: { adminPort: 13000 },
      }),
    );
  });

  it('rejects a non-uuid id on detail', () => {
    expect(() => controller().get(request, 'not-a-uuid')).toThrow(BadRequestException);
  });

  it('instantiate returns the template content ready for the generator', async () => {
    repository.getTemplate.mockResolvedValue({
      id: validId,
      name: 'Gateway',
      engine: 'kamex',
      content: { adminPort: 13000, smsboxPort: 13001 },
    });
    const result: any = await controller().instantiate(request, validId);
    expect(repository.getTemplate).toHaveBeenCalledWith(
      { tenantId: '7', userId: 'user-1' },
      validId,
    );
    expect(result).toMatchObject({
      templateId: validId,
      engine: 'kamex',
      content: { adminPort: 13000, smsboxPort: 13001 },
    });
    expect(typeof result.note).toBe('string');
  });

  it('deletes via DELETE', async () => {
    repository.deleteTemplate.mockResolvedValue({ id: validId, deleted: true });
    await expect(controller().remove(request, validId)).resolves.toMatchObject({ deleted: true });
    expect(repository.deleteTemplate).toHaveBeenCalledWith(
      { tenantId: '7', userId: 'user-1' },
      validId,
    );
  });
});
