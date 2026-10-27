-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "config" TEXT NOT NULL,
    "format" TEXT NOT NULL DEFAULT 'xlsx',
    "name" TEXT NOT NULL DEFAULT '',
    "inputFile" TEXT,
    "inputName" TEXT,
    "resultFile" TEXT,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "total" INTEGER NOT NULL DEFAULT 0,
    "stats" TEXT NOT NULL DEFAULT '[]',
    "log" TEXT NOT NULL DEFAULT '',
    "error" TEXT,
    "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
    "scheduleId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "finishedAt" DATETIME
);

-- CreateTable
CREATE TABLE "Schedule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "config" TEXT NOT NULL,
    "format" TEXT NOT NULL DEFAULT 'xlsx',
    "sourceUrl" TEXT,
    "uploadUrl" TEXT,
    "intervalMinutes" INTEGER NOT NULL,
    "nextRunAt" DATETIME NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastJobId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "Job_shop_createdAt_idx" ON "Job"("shop", "createdAt");

-- CreateIndex
CREATE INDEX "Job_status_createdAt_idx" ON "Job"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Schedule_enabled_nextRunAt_idx" ON "Schedule"("enabled", "nextRunAt");
