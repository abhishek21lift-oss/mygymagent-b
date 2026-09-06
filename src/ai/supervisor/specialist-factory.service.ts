import { Injectable } from '@nestjs/common';
import { MemberSpecialistService } from '../specialists/member-specialist.service';
import { WorkoutSpecialistService } from '../specialists/workout-specialist.service';
import { NutritionSpecialistService } from '../specialists/nutrition-specialist.service';
import { AnalyticsSpecialistService } from '../specialists/analytics-specialist.service';
import { CrmSpecialistService } from '../specialists/crm-specialist.service';
import { ActionsSpecialistService } from '../specialists/actions-specialist.service';
import { BriefingSpecialistService } from '../specialists/briefing-specialist.service';
import { BaseSpecialistService } from '../specialists/base-specialist.service';
import { AiToolName } from '../tools/tool-definitions';

@Injectable()
export class SpecialistFactoryService {
  private specialists: Map<AiToolName, BaseSpecialistService>;

  constructor(
    memberSpecialist: MemberSpecialistService,
    workoutSpecialist: WorkoutSpecialistService,
    nutritionSpecialist: NutritionSpecialistService,
    analyticsSpecialist: AnalyticsSpecialistService,
    crmSpecialist: CrmSpecialistService,
    actionsSpecialist: ActionsSpecialistService,
    briefingSpecialist: BriefingSpecialistService,
  ) {
    this.specialists = new Map();
    this.registerSpecialist(memberSpecialist);
    this.registerSpecialist(workoutSpecialist);
    this.registerSpecialist(nutritionSpecialist);
    this.registerSpecialist(analyticsSpecialist);
    this.registerSpecialist(crmSpecialist);
    this.registerSpecialist(actionsSpecialist);
    this.registerSpecialist(briefingSpecialist);
  }

  private registerSpecialist(specialist: BaseSpecialistService): void {
    for (const tool of specialist.getHandledTools()) {
      this.specialists.set(tool, specialist);
    }
  }

  getSpecialistForTool(tool: AiToolName): BaseSpecialistService {
    const specialist = this.specialists.get(tool);
    if (!specialist) throw new Error(`No specialist found for tool: ${tool}`);
    return specialist;
  }

  handlesTool(tool: AiToolName): boolean {
    return this.specialists.has(tool);
  }

  getAllHandledTools(): AiToolName[] {
    return Array.from(this.specialists.keys());
  }
}
