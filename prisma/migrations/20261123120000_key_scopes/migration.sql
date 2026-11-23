-- Access keys: limited to chosen data types, and who made them. Who may make full keys.
ALTER TABLE "ApiKey" ADD COLUMN "entities" TEXT;
ALTER TABLE "ApiKey" ADD COLUMN "createdBy" TEXT NOT NULL DEFAULT '';
ALTER TABLE "ShopSetting" ADD COLUMN "keyAdmins" TEXT NOT NULL DEFAULT '';
ALTER TABLE "ShopSetting" ADD COLUMN "squareImages" BOOLEAN NOT NULL DEFAULT false;
