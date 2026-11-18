-- AlterTable
ALTER TABLE "Job" ADD COLUMN "problems" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Job" ADD COLUMN "reviewedAt" DATETIME;
ALTER TABLE "Job" ADD COLUMN "alertedAt" DATETIME;

-- CreateTable
CREATE TABLE "ShopSetting" (
    "shop" TEXT NOT NULL PRIMARY KEY,
    "alertEmail" TEXT,
    "alertScope" TEXT NOT NULL DEFAULT 'scheduled',
    "updatedAt" DATETIME NOT NULL
);
