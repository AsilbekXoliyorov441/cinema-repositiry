-- AlterTable
ALTER TABLE "movies" ADD COLUMN     "ratingAvg" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "movies_ratingAvg_idx" ON "movies"("ratingAvg");
