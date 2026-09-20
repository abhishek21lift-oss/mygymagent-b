import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class DataService {
  constructor(private readonly prisma: PrismaService) {}

  async exportMembers(org: string) {
    const rows = await this.prisma.member.findMany({ where: { organizationId: org, deletedAt: null }, orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }] });
    const headers = ['id','firstName','lastName','email','phone','dateOfBirth','gender','status','primaryBranchId','assignedTrainerId','createdAt'];
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    return [headers.join(','), ...rows.map((m) => headers.map((h) => esc((m as any)[h])).join(','))].join('
');
  }

  private async defaultBranch(org: string) {
    const branch = await this.prisma.branch.findFirst({ where: { organizationId: org }, orderBy: { createdAt: 'asc' } });
    if (!branch) throw new BadRequestException('Organization has no branch for imported members');
    return branch.id;
  }

  async importMembers(org: string, rows: Record<string,string>[]) {
    if (!Array.isArray(rows) || rows.length === 0) throw new BadRequestException('No member rows supplied');
    if (rows.length > 2000) throw new BadRequestException('Import is limited to 2,000 rows per request');
    let created = 0, skipped = 0;
    const errors: Array<{ row: number; message: string }> = [];
    for (let i=0;i<rows.length;i++) {
      const r=rows[i];
      if (!r.firstName || !r.lastName) { errors.push({row:i+1,message:'firstName and lastName are required'}); continue; }
      try {
        const existing = r.email ? await this.prisma.member.findFirst({where:{organizationId:org,email:r.email,deletedAt:null}}) : null;
        if (existing) { skipped++; continue; }
        await this.prisma.member.create({data:{
          organizationId:org, memberCode: r.memberCode?.trim() || `IMP-${Date.now()}-${i+1}`, primaryBranchId: r.primaryBranchId?.trim() || (await this.defaultBranch(org)), firstName:r.firstName.trim(), lastName:r.lastName.trim(),
          email:r.email?.trim()||null, phone:r.phone?.trim()||null,
          dateOfBirth:r.dateOfBirth ? new Date(r.dateOfBirth) : null,
          gender:r.gender?.trim()||null, status:(r.status?.trim()||'ACTIVE') as any,
          primaryBranchId:r.primaryBranchId||null, assignedTrainerId:r.assignedTrainerId||null,
        }});
        created++;
      } catch (e) { errors.push({row:i+1,message:e instanceof Error?e.message:'Import failed'}); }
    }
    return { total: rows.length, created, skipped, errors };
  }
}
