-- Adds password-based sign-in alongside the existing Google/LinkedIn/magic-link
-- providers. NULL for every User created via OAuth or magic link — only a
-- User who has actually set a password can use the Credentials provider.
ALTER TABLE "User" ADD COLUMN "passwordHash" TEXT;
