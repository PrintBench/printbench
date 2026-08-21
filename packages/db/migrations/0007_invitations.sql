-- Invitations.
--
-- A self-hosted instance rarely has SMTP configured, so an invitation is a
-- link the admin copies and delivers however they already talk to the person.
-- That makes the token the whole of the secret, which is why it is generated
-- with the same length and reasoning as a share token.
--
-- The email is optional: an admin may be inviting a specific person, or
-- simply making a link for whoever needs one. When present it pre-fills the
-- acceptance form and is the address the account is created with.
CREATE TABLE "invitations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "token" text NOT NULL UNIQUE,
  "email" text,
  "role" text NOT NULL DEFAULT 'viewer',
  "created_by" text REFERENCES "user"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "expires_at" timestamp with time zone NOT NULL,
  -- Set when redeemed. Kept rather than deleted so the users list can show
  -- who came in through which invitation.
  "accepted_at" timestamp with time zone,
  "accepted_by" text REFERENCES "user"("id") ON DELETE SET NULL,
  "revoked_at" timestamp with time zone,
  CONSTRAINT "invitations_role_check" CHECK ("role" IN ('admin', 'member', 'viewer'))
);

-- The lookup on the acceptance path, which is unauthenticated and therefore
-- the one that must not table-scan.
CREATE INDEX "invitations_token_idx" ON "invitations" ("token");

-- Drives the pending list on the users page.
CREATE INDEX "invitations_pending_idx" ON "invitations" ("created_at" DESC)
  WHERE "accepted_at" IS NULL AND "revoked_at" IS NULL;
