import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';

const SIGNED_URL_EXPIRY_SECONDS = 15 * 60;

export interface UploadFileInput {
  organizationId: string;
  buffer: Buffer;
  originalName: string;
  mimeType: string;
  /// Namespaces the S3 key (e.g. "member-documents") -- purely a key-path
  /// convention for readability in the bucket, not an access-control
  /// mechanism. Access control is enforced in the DB layer (organizationId
  /// on the File row), never by "the key is hard to guess".
  pathPrefix: string;
}

export interface UploadFileResult {
  key: string;
  sizeBytes: number;
}

/**
 * Thin adapter over any S3-compatible object store (Cloudflare R2 in
 * production, s3rver locally -- see README.md), per
 * docs/integrations/overview.md's "every external integration sits behind
 * an adapter interface" rule. Domain code (e.g. MemberDocumentsService)
 * calls `upload`/`getSignedUrl`/`delete` and never touches the S3 SDK or
 * bucket name directly.
 *
 * S3 keys are never returned to a client. Every read goes through
 * `getSignedUrl`, generated fresh (15 min expiry) -- a key or a permanent
 * URL would bypass this service's ability to ever rotate credentials,
 * change buckets, or revoke access to a specific object.
 */
@Injectable()
export class FileStorageService {
  private readonly logger = new Logger(FileStorageService.name);
  private readonly client: S3Client | null;
  private readonly bucket: string | undefined;

  constructor(private readonly config: ConfigService) {
    const endpoint = this.config.get<string>('S3_ENDPOINT');
    const accessKeyId = this.config.get<string>('S3_ACCESS_KEY_ID');
    const secretAccessKey = this.config.get<string>('S3_SECRET_ACCESS_KEY');
    this.bucket = this.config.get<string>('S3_BUCKET');

    if (!endpoint || !accessKeyId || !secretAccessKey || !this.bucket) {
      this.logger.warn(
        'Object storage is not fully configured (S3_ENDPOINT/S3_BUCKET/S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY) -- file upload endpoints will return 503.',
      );
      this.client = null;
      return;
    }

    this.client = new S3Client({
      endpoint,
      region: this.config.get<string>('S3_REGION', 'auto'),
      credentials: { accessKeyId, secretAccessKey },
      // Required for R2/MinIO/s3rver -- they don't support AWS's
      // virtual-hosted-style bucket addressing (<bucket>.<endpoint>).
      forcePathStyle: true,
    });
  }

  private assertConfigured(): S3Client {
    if (!this.client) {
      throw new ServiceUnavailableException(
        'File storage is not configured on this deployment.',
      );
    }
    return this.client;
  }

  async upload(input: UploadFileInput): Promise<UploadFileResult> {
    const client = this.assertConfigured();
    const key = `org/${input.organizationId}/${input.pathPrefix}/${randomUUID()}-${sanitizeFilename(input.originalName)}`;

    await client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: input.buffer,
        ContentType: input.mimeType,
      }),
    );

    return { key, sizeBytes: input.buffer.length };
  }

  async getSignedUrl(key: string): Promise<string> {
    const client = this.assertConfigured();
    return getSignedUrl(
      client,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: SIGNED_URL_EXPIRY_SECONDS },
    );
  }

  async delete(key: string): Promise<void> {
    const client = this.assertConfigured();
    await client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-100);
}
