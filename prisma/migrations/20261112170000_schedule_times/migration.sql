-- AlterTable
ALTER TABLE "Schedule" ADD COLUMN "runAt" TEXT;
ALTER TABLE "Schedule" ADD COLUMN "timezone" TEXT;
ALTER TABLE "Schedule" ADD COLUMN "weekday" INTEGER;
