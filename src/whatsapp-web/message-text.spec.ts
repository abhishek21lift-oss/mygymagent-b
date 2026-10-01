import { messageText } from './whatsapp-web.manager';

describe('messageText', () => {
  it('reads plain and quoted text', () => {
    expect(messageText({ conversation: 'Plans' })).toBe('Plans');
    expect(messageText({ extendedTextMessage: { text: 'My plan' } })).toBe(
      'My plan',
    );
  });

  it('reads a disappearing-messages chat, which wraps every message', () => {
    expect(
      messageText({
        ephemeralMessage: {
          message: { extendedTextMessage: { text: 'Timings?' } },
        },
      }),
    ).toBe('Timings?');
  });

  it('reads the caption on a photo, video or document, view-once too', () => {
    expect(messageText({ imageMessage: { caption: 'fees?' } })).toBe('fees?');
    expect(messageText({ videoMessage: { caption: 'form check' } })).toBe(
      'form check',
    );
    expect(
      messageText({
        documentWithCaptionMessage: {
          message: { documentMessage: { caption: 'my receipt' } },
        },
      }),
    ).toBe('my receipt');
    expect(
      messageText({
        viewOnceMessageV2: { message: { imageMessage: { caption: 'hi' } } },
      }),
    ).toBe('hi');
  });

  it('has nothing for a sticker, voice note or empty caption', () => {
    expect(messageText({ imageMessage: { caption: '  ' } })).toBeNull();
    expect(messageText({})).toBeNull();
    expect(messageText(null)).toBeNull();
  });
});
