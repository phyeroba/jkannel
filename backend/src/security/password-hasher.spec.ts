import { PasswordHasher } from './password-hasher';

describe('PasswordHasher', () => {
  it('uses salted scrypt and verifies safely', async () => {
    const hasher = new PasswordHasher();
    const encoded = await hasher.hash('correct horse battery staple');
    expect(encoded).not.toContain('correct horse');
    await expect(hasher.verify('correct horse battery staple', encoded)).resolves.toBe(true);
    await expect(hasher.verify('incorrect password', encoded)).resolves.toBe(false);
  });
});
