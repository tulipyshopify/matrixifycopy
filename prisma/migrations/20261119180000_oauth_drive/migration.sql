ALTER TABLE "ShopSetting" ADD COLUMN "undoOnStop" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ShopSetting" ADD COLUMN "driveToken" TEXT;
ALTER TABLE "ShopSetting" ADD COLUMN "driveFolder" TEXT;
CREATE TABLE "OAuthGrant" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientId" TEXT NOT NULL,
    "redirectUri" TEXT NOT NULL,
    "challenge" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT '',
    "userCode" TEXT NOT NULL,
    "shop" TEXT,
    "approvedAt" DATETIME,
    "codeHash" TEXT,
    "codeUsedAt" DATETIME,
    "refreshHash" TEXT,
    "keyId" TEXT,
    "clientName" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "OAuthGrant_userCode_key" ON "OAuthGrant"("userCode");
CREATE UNIQUE INDEX "OAuthGrant_codeHash_key" ON "OAuthGrant"("codeHash");
CREATE UNIQUE INDEX "OAuthGrant_refreshHash_key" ON "OAuthGrant"("refreshHash");
CREATE INDEX "OAuthGrant_shop_idx" ON "OAuthGrant"("shop");
CREATE TABLE "OAuthClient" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL DEFAULT '',
    "redirectUris" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
