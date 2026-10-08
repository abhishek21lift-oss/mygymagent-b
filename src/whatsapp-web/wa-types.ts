/**
 * The slice of a Baileys socket this module uses.
 *
 * Declared here rather than taken from Baileys' own types so the rest of
 * the module -- and the specs, which drive fake sockets -- never has to
 * load Baileys: it is an ES module the CommonJS build can only reach
 * through a dynamic import, and a real socket opens a connection to
 * WhatsApp.
 */
export interface WaConnectionUpdate {
  connection?: 'open' | 'connecting' | 'close';
  qr?: string;
  lastDisconnect?: { error?: unknown };
}

export interface WaMessageKey {
  id?: string | null;
  fromMe?: boolean | null;
  remoteJid?: string | null;
  /** Baileys 7 addresses chats by LID and carries the phone JID here. */
  remoteJidAlt?: string | null;
  senderPn?: string | null;
}

/** The parts of a Baileys message body this app reads. */
export interface WaMessageContent {
  conversation?: string | null;
  extendedTextMessage?: { text?: string | null } | null;
  imageMessage?: { caption?: string | null } | null;
  videoMessage?: { caption?: string | null } | null;
  documentMessage?: { caption?: string | null } | null;
  /** Disappearing-messages chats wrap every message in this. */
  ephemeralMessage?: { message?: WaMessageContent | null } | null;
  viewOnceMessage?: { message?: WaMessageContent | null } | null;
  viewOnceMessageV2?: { message?: WaMessageContent | null } | null;
  documentWithCaptionMessage?: { message?: WaMessageContent | null } | null;
}

export interface WaMessage {
  key: WaMessageKey;
  message?: WaMessageContent | null;
}

export interface WaMessageUpdate {
  key: WaMessageKey;
  update: { status?: number | null };
}

export interface WaEventMap {
  'connection.update': WaConnectionUpdate;
  'messages.upsert': { messages: WaMessage[]; type: string };
  'messages.update': WaMessageUpdate[];
}

export interface WaSocket {
  ev: {
    on<E extends keyof WaEventMap>(
      event: E,
      listener: (arg: WaEventMap[E]) => void,
    ): void;
  };
  user?: { id: string } | null;
  sendMessage(
    jid: string,
    content: { text: string },
  ): Promise<{ key?: { id?: string | null } } | undefined>;
  onWhatsApp(
    ...jids: string[]
  ): Promise<Array<{ jid: string; exists: boolean }> | undefined>;
  requestPairingCode(phoneNumber: string): Promise<string>;
  logout(): Promise<void>;
  end(error?: Error): void;
}

export interface WaSocketFactory {
  /** A socket for the gym's linked number, resuming the stored session
   * (by `WaSession.id`) when there is one and starting a fresh pairing
   * when not. */
  create(input: {
    organizationId: string;
    waSessionId: string;
  }): Promise<WaSocket>;
}

export const WA_SOCKET_FACTORY = Symbol('WA_SOCKET_FACTORY');

/** WhatsApp's receipt levels, as Baileys reports them on `messages.update`. */
export const WA_ACK = { SERVER: 2, DELIVERED: 3, READ: 4, PLAYED: 5 } as const;

/** Disconnect reasons this module acts on (Baileys' `DisconnectReason`). */
export const WA_DISCONNECT = {
  LOGGED_OUT: 401,
  FORBIDDEN: 403,
  TIMED_OUT: 408,
  RESTART_REQUIRED: 515,
} as const;

/** The number is not registered on WhatsApp: retrying cannot help. */
export class NotOnWhatsappError extends Error {
  constructor() {
    super("This number isn't on WhatsApp");
    this.name = 'NotOnWhatsappError';
  }
}

/** No open socket for the gym on this server instance right now. */
export class NotLinkedError extends Error {
  constructor(message = 'WhatsApp is not linked right now') {
    super(message);
    this.name = 'NotLinkedError';
  }
}

/**
 * The words in a message: a plain or quoted text, or the caption on a
 * photo, video or document -- inside the wrapper WhatsApp puts around
 * every message in a disappearing-messages chat, or a view-once one.
 */
export function messageText(
  content: WaMessageContent | null | undefined,
  depth = 0,
): string | null {
  if (!content || depth > 3) return null;
  const inner =
    content.ephemeralMessage?.message ??
    content.viewOnceMessage?.message ??
    content.viewOnceMessageV2?.message ??
    content.documentWithCaptionMessage?.message;
  if (inner) return messageText(inner, depth + 1);
  const text =
    content.conversation ??
    content.extendedTextMessage?.text ??
    content.imageMessage?.caption ??
    content.videoMessage?.caption ??
    content.documentMessage?.caption;
  return text?.trim() ? text : null;
}

/** The chat's phone-number JID, whichever field Baileys put it in. */
export function phoneJid(key: WaMessageKey): string | null {
  for (const jid of [key.remoteJid, key.remoteJidAlt, key.senderPn]) {
    if (jid?.endsWith('@s.whatsapp.net')) return jid;
  }
  return null;
}

/** `919812345678:12@s.whatsapp.net` -> `919812345678`. */
export function jidDigits(jid: string | null | undefined): string | null {
  if (!jid) return null;
  const digits = jid.split('@')[0].split(':')[0].replace(/\D/g, '');
  return digits || null;
}
