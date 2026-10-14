import {
  BILL_MESSAGE_VARIABLES,
  findUnknownVariables,
  hasUnresolvedVariables,
} from './template-variables';

describe('template variables', () => {
  it('accepts variables the real data models provide', () => {
    expect(findUnknownVariables('Hi {{firstName}}, {{amount}}')).toEqual([]);
    expect(
      findUnknownVariables(
        '{{salutation}} {{organizationName}}',
        BILL_MESSAGE_VARIABLES,
      ),
    ).toEqual([]);
  });

  it('rejects variables no sender resolves', () => {
    expect(findUnknownVariables('Hi {{nickname}}')).toEqual(['nickname']);
    expect(
      findUnknownVariables('{{memberPassword}}', BILL_MESSAGE_VARIABLES),
    ).toEqual(['memberPassword']);
  });

  it('accepts Meta-style positional slots', () => {
    expect(
      findUnknownVariables('Hi {{1}}, invoice {{2}} for {{3}} {{4}}'),
    ).toEqual([]);
  });

  it('detects an unresolved placeholder in rendered text', () => {
    expect(hasUnresolvedVariables('Hi Rahul, all set')).toBe(false);
    expect(hasUnresolvedVariables('Hi {{mystery}}, all set')).toBe(true);
  });
});
