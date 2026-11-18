-- Email alerts were removed: failures are flagged in the app only.
ALTER TABLE "Job" DROP COLUMN "alertedAt";
ALTER TABLE "ShopSetting" DROP COLUMN "alertEmail";
ALTER TABLE "ShopSetting" DROP COLUMN "alertScope";
