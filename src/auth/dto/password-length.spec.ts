import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { DisableMfaDto } from '../mfa/dto/mfa.dto';
import { LoginDto } from './login.dto';
import { RegisterDto } from './register.dto';
import { ResetPasswordDto } from './reset-password.dto';

/** argon2id spends 64 MiB per hash: an unbounded password field is a
 * memory/CPU amplifier, so every one is capped at 128 and refused with a
 * 400 before any handler (and so any hash) runs. */
describe('password length cap', () => {
  const pipe = new ValidationPipe({ whitelist: true, transform: true });
  const long = 'x'.repeat(129);
  const ok = 'x'.repeat(128);

  const run = (metatype: new () => object, value: object) =>
    pipe.transform(value, { type: 'body', metatype });

  it.each([
    [LoginDto, { email: 'a@example.com', password: long }],
    [
      RegisterDto,
      {
        organizationName: 'Gym',
        email: 'a@example.com',
        password: long,
        firstName: 'A',
        lastName: 'B',
      },
    ],
    [ResetPasswordDto, { token: 't', newPassword: long }],
    [DisableMfaDto, { password: long, code: '123456' }],
  ])('%p refuses a 129-character password', async (dto, body) => {
    await expect(run(dto, body)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts a 128-character login password', async () => {
    await expect(
      run(LoginDto, { email: 'a@example.com', password: ok }),
    ).resolves.toBeDefined();
  });
});
