-- Add MemberType enum
CREATE TYPE "MemberType" AS ENUM ('GYM', 'PT', 'GYM_PT');

-- Add memberType and leadSource to Member
ALTER TABLE "members" ADD COLUMN "memberType" "MemberType";
ALTER TABLE "members" ADD COLUMN "leadSource" TEXT;

-- Add discount to Membership
ALTER TABLE "memberships" ADD COLUMN "discount" DECIMAL(10,2);
