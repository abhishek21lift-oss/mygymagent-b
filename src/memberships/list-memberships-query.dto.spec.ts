import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ListMembershipsQueryDto } from './dto/list-memberships-query.dto';

describe('ListMembershipsQueryDto created-range filter', () => {
  async function errorsFor(input: Record<string, unknown>) {
    return validate(plainToInstance(ListMembershipsQueryDto, input));
  }

  it('accepts an omitted or valid range', async () => {
    expect(await errorsFor({})).toHaveLength(0);
    expect(
      await errorsFor({ createdFrom: '2026-10-06', createdTo: '2026-10-06' }),
    ).toHaveLength(0);
  });

  it('rejects non-date strings', async () => {
    const errors = await errorsFor({ createdTo: '06/10/2026' });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].property).toBe('createdTo');
  });
});
