-- Step 4 (second migration): per-user partial unique guards.
--
-- These partial unique indexes cannot be expressed in schema.prisma, so Prisma
-- `migrate diff --to-schema` will report them as drift (DROP INDEX). DO NOT
-- "fix" that drift: the guards are intentional and documented in schema.prisma
-- and README. They are the final protection against concurrent inserts of the
-- same person.
--
-- Run only AFTER: backfill-identity -> report-duplicates -> apply-duplicate-links --apply

-- Fail fast (do not silently delete) if unresolved duplicate rows exist.
DO $$
DECLARE
  v_instagram int;
  v_username int;
  v_email int;
BEGIN
  SELECT count(*) INTO v_instagram FROM (
    SELECT 1 FROM "Lead"
    WHERE "duplicateOfLeadId" IS NULL AND "userId" IS NOT NULL AND "instagramUserId" IS NOT NULL
    GROUP BY "userId", "instagramUserId" HAVING count(*) > 1
  ) t;

  SELECT count(*) INTO v_username FROM (
    SELECT 1 FROM "Lead"
    WHERE "duplicateOfLeadId" IS NULL AND "userId" IS NOT NULL AND "usernameNormalized" IS NOT NULL
    GROUP BY "userId", "usernameNormalized" HAVING count(*) > 1
  ) t;

  SELECT count(*) INTO v_email FROM (
    SELECT 1 FROM "Lead"
    WHERE "duplicateOfLeadId" IS NULL AND "userId" IS NOT NULL AND "emailNormalized" IS NOT NULL
    GROUP BY "userId", "emailNormalized" HAVING count(*) > 1
  ) t;

  IF v_instagram > 0 OR v_username > 0 OR v_email > 0 THEN
    RAISE EXCEPTION
      'Step 4 unique guards blocked: unresolved duplicates (instagramUserId=%, usernameNormalized=%, emailNormalized=%). Run scripts/apply-duplicate-links.ts --apply first.',
      v_instagram, v_username, v_email;
  END IF;
END $$;

-- Partial unique indexes (ignore duplicate-linked rows and NULL keys).
CREATE UNIQUE INDEX "Lead_userId_instagramUserId_active_key"
  ON "Lead" ("userId", "instagramUserId")
  WHERE "instagramUserId" IS NOT NULL AND "duplicateOfLeadId" IS NULL;

CREATE UNIQUE INDEX "Lead_userId_usernameNormalized_active_key"
  ON "Lead" ("userId", "usernameNormalized")
  WHERE "usernameNormalized" IS NOT NULL AND "duplicateOfLeadId" IS NULL;

CREATE UNIQUE INDEX "Lead_userId_emailNormalized_active_key"
  ON "Lead" ("userId", "emailNormalized")
  WHERE "emailNormalized" IS NOT NULL AND "duplicateOfLeadId" IS NULL;
