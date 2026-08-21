import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateFoodItemDto } from './dto/create-food-item.dto';

@Injectable()
export class FoodItemsService {
  constructor(private readonly prisma: PrismaService) {}

  list(organizationId: string) {
    return this.prisma.foodItem.findMany({
      where: { organizationId },
      orderBy: { name: 'asc' },
    });
  }

  // Duplicate names within an org are rejected by the DB's unique
  // constraint (organizationId, name) -> AllExceptionsFilter maps the
  // resulting P2002 to a 409, same convention as every other module here.
  create(organizationId: string, dto: CreateFoodItemDto) {
    return this.prisma.foodItem.create({ data: { organizationId, ...dto } });
  }
}
