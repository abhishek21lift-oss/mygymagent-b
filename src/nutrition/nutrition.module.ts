import { Module } from '@nestjs/common';
import { DietAssignmentsController } from './diet-assignments.controller';
import { DietAssignmentsService } from './diet-assignments.service';
import { DietPlansController } from './diet-plans.controller';
import { DietPlansService } from './diet-plans.service';
import { FoodItemsController } from './food-items.controller';
import { FoodItemsService } from './food-items.service';

/**
 * v1 nutrition engine: food library, named diet plans (a flat list of food
 * items with quantities, mirroring the Workouts module's shape exactly),
 * and assigning a plan to a member with status tracking. See README.md.
 */
@Module({
  controllers: [
    FoodItemsController,
    DietPlansController,
    DietAssignmentsController,
  ],
  providers: [FoodItemsService, DietPlansService, DietAssignmentsService],
  exports: [FoodItemsService, DietPlansService, DietAssignmentsService],
})
export class NutritionModule {}
