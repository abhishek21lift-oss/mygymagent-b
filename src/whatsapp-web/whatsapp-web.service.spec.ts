import { WhatsappWebService } from './whatsapp-web.service';

function service(env: Record<string, string | undefined>, enabled = true) {
  const config = { get: (key: string) => env[key] };
  const manager = { enabled };
  return new WhatsappWebService({} as never, config as never, manager as never);
}

describe('WhatsappWebService.availability', () => {
  const key = 'ab'.repeat(32);

  it('names the setting that is missing, so the page can say which', () => {
    expect(service({}, false).availability()).toEqual({
      available: false,
      unavailableReason: 'DISABLED',
    });
    expect(service({}).availability()).toEqual({
      available: false,
      unavailableReason: 'KEY_MISSING',
    });
    expect(
      service({ WHATSAPP_TOKEN_KEY: '<64 hex characters>' }).availability(),
    ).toEqual({
      available: false,
      unavailableReason: 'KEY_INVALID',
    });
    expect(
      service({ WHATSAPP_TOKEN_KEY: key.slice(0, 32) }).availability()
        .unavailableReason,
    ).toBe('KEY_INVALID');
  });

  it('accepts a valid key, including one pasted with a trailing newline', () => {
    expect(service({ WHATSAPP_TOKEN_KEY: key }).availability()).toEqual({
      available: true,
      unavailableReason: null,
    });
    expect(service({ WHATSAPP_TOKEN_KEY: `${key}\n` }).available()).toBe(true);
  });
});
