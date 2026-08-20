import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Public } from '../common/decorators/public.decorator';
import { PrismaService } from '../prisma/prisma.service';

@Controller()
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Liveness: is the process itself up? No dependency checks. An
   * orchestrator uses this to decide whether to restart the container.
   */
  @Public()
  @Get('health')
  @HttpCode(HttpStatus.OK)
  liveness() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  /**
   * Readiness: can this instance actually serve traffic? Checks the
   * database connection. An orchestrator/load balancer uses this to decide
   * whether to route requests here; a 503 pulls the instance out of
   * rotation without restarting it.
   */
  @Public()
  @Get('ready')
  async readiness() {
    const startedAt = Date.now();
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      throw new ServiceUnavailableException({
        status: 'not_ready',
        database: 'down',
      });
    }
    return {
      status: 'ready',
      database: 'up',
      latencyMs: Date.now() - startedAt,
      timestamp: new Date().toISOString(),
    };
  }
}
