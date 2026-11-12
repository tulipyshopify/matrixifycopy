-- AlterTable
ALTER TABLE "Schedule" ADD COLUMN "linkDownloads" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Schedule" ADD COLUMN "lastDownloadAt" DATETIME;
