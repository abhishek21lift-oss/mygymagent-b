import { Injectable } from '@nestjs/common';
import { BaseSpecialistService } from './base-specialist.service';
import { MembersService } from '../../members/members.service';
import { AttendanceService } from '../../attendance/attendance.service';
import { AiToolName } from '../tools/tool-definitions';
import { ToolExecutorService } from '../tools/tool-executor.service';
import { AiActionsService } from '../../ai-actions/ai-actions.service';

@Injectable()
export class MemberSpecialistService extends BaseSpecialistService {
  constructor(
    toolExecutorService: ToolExecutorService,
    aiActionsService: AiActionsService,
    private readonly membersService: MembersService,
    private readonly attendanceService: AttendanceService,
  ) {
    super(toolExecutorService, aiActionsService);
  }

  getHandledTools(): AiToolName[] {
    return ['read_member', 'read_attendance'];
  }
}
