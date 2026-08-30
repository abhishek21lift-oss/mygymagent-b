import {
  BeforeInsert,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  UpdateDateColumn,
} from 'typeorm';
import { Branch } from '../branches/branch.entity';
import { Member } from '../members/member.entity';
import { StaffProfile } from '../staff-profiles/staff-profile.entity';
import { User } from '../users/user.entity';

export enum PtSessionStatus {
  SCHEDULED = 'SCHEDULED',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
  NO_SHOW = 'NO_SHOW',
}

export enum PtSessionType {
  PERSONAL_TRAINING = 'PERSONAL_TRAINING',
  PARTNER_TRAINING = 'PARTNER_TRAINING',
  SMALL_GROUP = 'SMALL_GROUP',
}

@Entity('pt_sessions')
export class PtSession {
  @Column({ type: 'uuid', primary: true, generated: 'uuid' })
  id: string;

  @Column()
  organizationId: string;

  @ManyToOne(() => Organization, (organization) => organization.ptSessions)
  @JoinColumn({ name: 'organizationId' })
  organization: Organization;

  @Column()
  memberId: string;

  @ManyToOne(() => Member, (member) => member.ptSessions)
  @JoinColumn({ name: 'memberId' })
  member: Member;

  @Column({ nullable: true })
  trainerId?: string;

  @ManyToOne(() => StaffProfile, (trainer) => trainer.ptSessions)
  @JoinColumn({ name: 'trainerId' })
  trainer?: StaffProfile;

  @Column()
  branchId: string;

  @ManyToOne(() => Branch, (branch) => branch.ptSessions)
  @JoinColumn({ name: 'branchId' })
  branch: Branch;

  @Column()
  startTime: Date;

  @Column()
  endTime: Date;

  @Column({ type: 'enum', enum: PtSessionType })
  type: PtSessionType;

  @Column({
    type: 'enum',
    enum: PtSessionStatus,
    default: PtSessionStatus.SCHEDULED,
  })
  status: PtSessionStatus;

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  price?: number;

  @Column({ type: 'boolean', default: false })
  isPaid: boolean;

  @Column({ type: 'text', nullable: true })
  notes?: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @BeforeInsert()
  validateTimes() {
    if (this.startTime >= this.endTime) {
      throw new Error('Session end time must be after start time');
    }
  }
}
