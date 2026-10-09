import { ValidationPipe } from '@nestjs/common';
import { GlobalCommandDto } from './global-command.dto';

// The same options main.ts gives the global pipe.
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});
const validate = (body: unknown) =>
  pipe.transform(body, { type: 'body', metatype: GlobalCommandDto });

describe('GlobalCommandDto', () => {
  it('accepts a command with optional context', async () => {
    await expect(
      validate({ command: 'Who is at risk?', context: { branchId: 'b1' } }),
    ).resolves.toMatchObject({ command: 'Who is at risk?' });
  });

  it('refuses an oversized or missing command', async () => {
    await expect(validate({ command: 'x'.repeat(2001) })).rejects.toThrow();
    await expect(validate({ command: '' })).rejects.toThrow();
    await expect(validate({})).rejects.toThrow();
  });

  it('refuses identity fields in the body', async () => {
    await expect(
      validate({ command: 'hi', organizationId: 'other-org' }),
    ).rejects.toThrow();
  });
});
