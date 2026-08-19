import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'crypto';

declare module 'express-serve-static-core' {
  interface Request {
    requestId: string;
  }
}

const HEADER = 'x-request-id';

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const incoming = req.header(HEADER);
    req.requestId =
      incoming && incoming.length <= 128 ? incoming : randomUUID();
    res.setHeader(HEADER, req.requestId);
    next();
  }
}
