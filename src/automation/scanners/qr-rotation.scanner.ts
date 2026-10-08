import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  freshQrCredential,
  qrTokenKey,
} from '../../attendance/member-qr-token';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * WS-3 QR rotation. Regenerates every MemberQrToken whose `rotatesAt` has
 * passed: a fresh code replaces the old one and `rotatesAt` moves forward
 * another validity window. The member and the desk see the new code the
 * next time they open it. Runs weekly via the automation queue's
 * repeatable scheduler; safe to re-run (only expired rows are touched).
 */
@Injectable()
export class QrRotationScanner {
  private readonly logger = new Logger(QrRotationScanner.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async scan(): Promise<{ checked: number; rotated: number }> {
    const now = new Date();
    const expired = await this.prisma.memberQrToken.findMany({
      where: { rotatesAt: { lte: now } },
      select: { memberId: true, tokenHash: true },
      take: 500,
    });
    const key = qrTokenKey(this.config);
    let rotated = 0;
    for (const row of expired) {
      // Only if nobody replaced it since it was read: a code the desk
      // just showed someone must not be retired behind their back.
      const { count } = await this.prisma.memberQrToken.updateMany({
        where: { memberId: row.memberId, tokenHash: row.tokenHash },
        data: freshQrCredential(key, row.memberId).data,
      });
      rotated += count;
    }
    this.logger.log(
      `QR rotation scan: ${expired.length} expired tokens, ${rotated} rotated`,
    );
    return { checked: expired.length, rotated };
  }
}
