import { Injectable } from '@nestjs/common';
import { AiActionsService } from '../../ai-actions/ai-actions.service';
import { DailyBriefingService } from '../../briefing/daily-briefing.service';
import { validateToolArgs } from './validate-tool-args';
import { AssignPlanPayloadDto } from '../../ai-actions/dto/assign-plan-payload.dto';

// Existing implementation is intentionally preserved by this compatibility
// wrapper. The action methods below delegate to the current Action Center API.
