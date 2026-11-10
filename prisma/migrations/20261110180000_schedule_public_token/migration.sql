-- AlterTable
ALTER TABLE "Schedule" ADD COLUMN "publicToken" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Schedule_publicToken_key" ON "Schedule"("publicToken");
