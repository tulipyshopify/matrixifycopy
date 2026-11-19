ALTER TABLE "ShopSetting" ADD COLUMN "failStopPercent" INTEGER NOT NULL DEFAULT 5;
ALTER TABLE "ShopSetting" ADD COLUMN "historyDays" INTEGER NOT NULL DEFAULT 90;
ALTER TABLE "ShopSetting" ADD COLUMN "alertEmails" TEXT NOT NULL DEFAULT '';
ALTER TABLE "ShopSetting" ADD COLUMN "backupBucket" TEXT;
ALTER TABLE "ApiKey" ADD COLUMN "readOnly" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ApiKey" ADD COLUMN "expiresAt" DATETIME;
ALTER TABLE "Preset" ADD COLUMN "userId" TEXT NOT NULL DEFAULT '';
DROP INDEX "Preset_shop_name_key";
CREATE UNIQUE INDEX "Preset_shop_userId_name_key" ON "Preset"("shop", "userId", "name");
