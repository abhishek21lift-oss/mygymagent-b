import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateExerciseDto } from './dto/create-exercise.dto';

@Injectable()
export class ExercisesService {
  constructor(private readonly prisma: PrismaService) {}

  list(organizationId: string) {
    return this.prisma.exercise.findMany({
      where: { organizationId },
      orderBy: { name: 'asc' },
    });
  }

  // Duplicate names within an org are rejected by the DB's unique
  // constraint (organizationId, name) -> AllExceptionsFilter maps the
  // resulting P2002 to a 409, same convention as every other module here.
  create(organizationId: string, dto: CreateExerciseDto) {
    return this.prisma.exercise.create({ data: { organizationId, ...dto } });
  }
}
