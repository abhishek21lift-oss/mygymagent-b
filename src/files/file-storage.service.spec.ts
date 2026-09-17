import { BadRequestException } from '@nestjs/common';
import { FileStorageService, sniffMimeType } from './file-storage.service';

describe('sniffMimeType', () => {
  it('recognizes JPEG/PNG/WebP/PDF magic bytes', () => {
    expect(
      sniffMimeType(
        Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]),
      ),
    ).toBe('image/jpeg');
    expect(
      sniffMimeType(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]),
      ),
    ).toBe('image/png');
    expect(
      sniffMimeType(Buffer.from('RIFF\x00\x00\x00\x00WEBPvp8 ', 'ascii')),
    ).toBe('image/webp');
    expect(sniffMimeType(Buffer.from('%PDF-1.4 fake'))).toBe('application/pdf');
  });

  it('returns null for unknown or truncated content', () => {
    expect(sniffMimeType(Buffer.from('fake-jpeg-bytes'))).toBeNull();
    expect(sniffMimeType(Buffer.from([0xff, 0xd8]))).toBeNull();
    expect(sniffMimeType(Buffer.alloc(0))).toBeNull();
  });
});

describe('FileStorageService.upload validation', () => {
  // Unconfigured storage: validation runs before the 503 assert, so MIME
  // behaviour is testable without S3.
  const service = new FileStorageService({
    get: () => undefined,
  } as never);

  it('rejects bytes that do not match the claimed type', async () => {
    await expect(
      service.upload({
        organizationId: 'org_1',
        buffer: Buffer.from('fake-jpeg-bytes'),
        originalName: 'progress.jpg',
        mimeType: 'image/jpeg',
        pathPrefix: 'member-documents',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects scripts even when the claimed type is allowed', async () => {
    await expect(
      service.upload({
        organizationId: 'org_1',
        buffer: Buffer.from('#!/bin/sh\necho hi'),
        originalName: 'doc.pdf',
        mimeType: 'application/pdf',
        pathPrefix: 'member-documents',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
