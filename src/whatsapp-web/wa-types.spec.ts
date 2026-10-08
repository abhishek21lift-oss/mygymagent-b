import {
  messageText,
  type WaSocket,
  type WaSendContent,
} from './wa-types';

describe('wa-types P1 rich-send', () => {
  it('messageText still reads an image caption', () => {
    expect(messageText({ imageMessage: { caption: 'hello' } })).toBe('hello');
    expect(messageText({ imageMessage: { caption: '   ' } })).toBeNull();
  });

  it('a socket accepts image content with caption and reply', () => {
    const sent: WaSendContent[] = [];
    const fake: WaSocket = {
      ev: { on: () => undefined },
      sendMessage: async (jid: string, content: WaSendContent) => {
        expect(jid).toBe('919876543210@s.whatsapp.net');
        sent.push(content);
        return { key: { id: 'ABC123' } };
      },
      onWhatsApp: async () => [],
      requestPairingCode: async () => '123-456',
      logout: async () => undefined,
      end: () => undefined,
    };
    const content: WaSendContent = {
      image: Buffer.from('fake-bytes'),
      caption: 'skole kya time hai?',
      mimetype: 'image/jpeg',
      replyToMessageId: 'WAMSG1',
    };
    return expect(
      fake.sendMessage('919876543210@s.whatsapp.net', content),
    ).resolves.toEqual({ key: { id: 'ABC123' } });
  });
});
