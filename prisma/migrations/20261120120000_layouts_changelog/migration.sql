ALTER TABLE "ShopSetting" ADD COLUMN "columnLayouts" TEXT NOT NULL DEFAULT '[]';
CREATE TABLE "ChangeLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "itemKey" TEXT NOT NULL,
    "itemId" TEXT NOT NULL DEFAULT '',
    "title" TEXT NOT NULL DEFAULT '',
    "action" TEXT NOT NULL DEFAULT 'update',
    "changes" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "ChangeLog_shop_itemKey_idx" ON "ChangeLog"("shop", "itemKey");
CREATE INDEX "ChangeLog_shop_itemId_idx" ON "ChangeLog"("shop", "itemId");
CREATE INDEX "ChangeLog_shop_createdAt_idx" ON "ChangeLog"("shop", "createdAt");
CREATE INDEX "ChangeLog_jobId_idx" ON "ChangeLog"("jobId");
