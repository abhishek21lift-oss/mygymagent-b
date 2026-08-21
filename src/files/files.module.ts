import { Global, Module } from '@nestjs/common';
import { FileStorageService } from './file-storage.service';

/**
 * Global so any domain module can inject FileStorageService without a
 * direct import -- same pattern as QueueModule (src/queue/). No
 * controllers here: this module owns the generic storage adapter only.
 * The first (and so far only) API surface over it is nested under
 * members (src/members/member-documents.*), not a standalone /files
 * resource -- see docs/architecture/discovery-report.md's Phase D notes.
 */
@Global()
@Module({
  providers: [FileStorageService],
  exports: [FileStorageService],
})
export class FilesModule {}
