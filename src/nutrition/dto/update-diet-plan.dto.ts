import { PartialType } from '@nestjs/mapped-types';
import { CreateDietPlanDto } from './create-diet-plan.dto';

export class UpdateDietPlanDto extends PartialType(CreateDietPlanDto) {}
