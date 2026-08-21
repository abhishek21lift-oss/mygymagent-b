import { Injectable, NotFoundException } from '@nestjs/common';
import type { CommunicationChannel } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class MessageTemplateService {
  constructor(private readonly prisma: PrismaService) {}

  /** Org-specific override if one exists, else the system default
   * (organizationId: null, seeded by prisma/seed.ts from
   * default-templates.catalog.ts). Throws if neither exists -- a missing
   * system-default row for a key CommunicationsService's callers actually
   * use is a seed-data bug, not a runtime condition to degrade
   * gracefully from. */
  async resolve(
    organizationId: string | null,
    key: string,
    channel: CommunicationChannel,
  ) {
    const override = organizationId
      ? await this.prisma.messageTemplate.findUnique({
          where: {
            organizationId_key_channel: { organizationId, key, channel },
          },
        })
      : null;
    if (override) return override;

    const systemDefault = await this.prisma.messageTemplate.findFirst({
      where: { organizationId: null, key, channel },
    });
    if (!systemDefault) {
      throw new NotFoundException(
        `No template (and no system default) for key "${key}" on channel ${channel}`,
      );
    }
    return systemDefault;
  }

  /** Plain `{{variable}}` substitution -- see default-templates.catalog.ts
   * for why this isn't a full templating engine (no HTML channel yet). A
   * placeholder with no matching variable is left as-is rather than
   * silently blanked, so a missing variable is visible in the rendered
   * output instead of producing a message that reads as complete but
   * isn't. */
  render(text: string, variables: Record<string, string>): string {
    return text.replace(/\{\{(\w+)\}\}/g, (match, name: string) =>
      Object.prototype.hasOwnProperty.call(variables, name)
        ? variables[name]
        : match,
    );
  }
}
