import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

/**
 * Validates a tool's raw (model-supplied) arguments against a DTO class --
 * the same class-validator machinery the global ValidationPipe uses for
 * ordinary HTTP requests, just invoked programmatically since tool calls
 * don't arrive as an HTTP request. Per docs/ai/architecture.md's "§57 --
 * structured outputs, validated before persistence": model output never
 * reaches a Prisma call directly, always through this first.
 */
export function validateToolArgs<T extends object>(
  cls: new () => T,
  args: unknown,
): T {
  const instance = plainToInstance(cls, args ?? {});
  const errors = validateSync(instance as object, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  if (errors.length > 0) {
    const message = errors
      .map((e) => Object.values(e.constraints ?? {}).join('; '))
      .join('; ');
    throw new BadRequestException(`Invalid tool arguments: ${message}`);
  }
  return instance;
}
