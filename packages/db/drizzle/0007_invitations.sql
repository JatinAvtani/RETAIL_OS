CREATE TABLE IF NOT EXISTS "invitations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" "membership_role" NOT NULL,
	"store_ids" uuid[],
	"token_hash" text NOT NULL,
	"invited_by" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

-- Same RLS treatment as every other tenant table (memberships, stores, audit_logs): listing,
-- creating, and revoking invitations from inside an authenticated org context goes through the
-- normal RLS-protected path. The one legitimate exception — resolving an invitation by its raw
-- token, before the invitee has any org context — is handled below via a SECURITY DEFINER
-- function, the same pattern already established for login's cross-org membership lookup.
ALTER TABLE "invitations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invitations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "invitations"
  USING (organization_id = current_setting('app.current_org_id')::uuid);
--> statement-breakpoint

-- Accepting an invitation happens by token, before the invitee's org context is known — the same
-- chicken-and-egg problem login's SECURITY DEFINER function solves for cross-org membership
-- lookup (0005_login_membership_lookup.sql). The token itself (256 bits of random entropy,
-- checked by hash) is the credential here, not organization_id, so bypassing RLS for this one
-- narrow, single-purpose read is safe: retailos_app gets EXECUTE on the function and nothing
-- else, every other invitations query still goes through the normal RLS-protected path.
CREATE FUNCTION find_invitation_by_token_hash(p_token_hash text)
RETURNS TABLE (
  id uuid,
  organization_id uuid,
  email text,
  role membership_role,
  store_ids uuid[],
  expires_at timestamptz,
  accepted_at timestamptz,
  revoked_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT i.id, i.organization_id, i.email, i.role, i.store_ids, i.expires_at, i.accepted_at, i.revoked_at
  FROM invitations i
  WHERE i.token_hash = p_token_hash;
$$;

REVOKE ALL ON FUNCTION find_invitation_by_token_hash(text) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'retailos_app') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION find_invitation_by_token_hash(text) TO retailos_app';
  END IF;
END
$$;

-- Accepting an invitation needs to do TWO things atomically: mark the invitation accepted, and
-- create the real membership row — and creating that row hits the exact same chicken-and-egg
-- problem as the read above (INSERT is gated by the same USING policy as SELECT/UPDATE/DELETE
-- under FORCE ROW LEVEL SECURITY, confirmed directly: `INSERT INTO memberships...` as
-- retailos_app with no SET LOCAL throws the identical "unrecognized configuration parameter"
-- error a raw SELECT would). One SECURITY DEFINER function doing both in a single statement (a
-- CTE chains the UPDATE and INSERT so they succeed or fail together — this is not two separate
-- bypasses, it's one atomic operation) is narrower and safer than two functions a caller could
-- invoke out of order or only partially.
--
-- p_user_id is the ALREADY-AUTHENTICATED caller accepting the invite — this function does not
-- resolve or trust an email from the token; the caller's own session determines whose membership
-- gets created, closing the "accepting while logged in as someone else" bug class the plan calls
-- out explicitly. The invitee-email match against the invitation is enforced at the application
-- layer (InvitationRepository/the tRPC procedure), before this function is ever called, using the
-- read function above.
CREATE FUNCTION accept_invitation_by_token_hash(p_token_hash text, p_user_id uuid)
RETURNS TABLE (
  membership_id uuid,
  organization_id uuid,
  role membership_role,
  store_ids uuid[]
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH accepted AS (
    UPDATE invitations
    SET accepted_at = now()
    WHERE token_hash = p_token_hash
      AND accepted_at IS NULL
      AND revoked_at IS NULL
      AND expires_at > now()
    RETURNING id, organization_id, role, store_ids
  ),
  created AS (
    INSERT INTO memberships (id, organization_id, user_id, role, store_ids, invited_by, accepted_at)
    SELECT gen_random_uuid(), accepted.organization_id, p_user_id, accepted.role, accepted.store_ids,
           (SELECT invited_by FROM invitations WHERE id = accepted.id), now()
    FROM accepted
    RETURNING id, organization_id, role, store_ids
  )
  SELECT id AS membership_id, organization_id, role, store_ids FROM created;
$$;

REVOKE ALL ON FUNCTION accept_invitation_by_token_hash(text, uuid) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'retailos_app') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION accept_invitation_by_token_hash(text, uuid) TO retailos_app';
  END IF;
END
$$;

-- Login needs to know whether a PENDING invitation exists for an email, by email, across every
-- organization — the same cross-org, no-context-yet shape as find_accepted_memberships_for_login,
-- solving a real gap: a brand-new invitee has zero accepted memberships (so login's normal
-- rejection would apply) but still needs SOME session to call invitations.accept in the first
-- place. Returns at most the single most-recently-issued pending invitation for that email; if
-- more than one exists across different orgs, login treats that the same way it treats multiple
-- accepted memberships — not supported yet, a real tracked gap, not a silent pick.
CREATE FUNCTION find_pending_invitation_by_email(p_email text)
RETURNS TABLE (
  organization_id uuid,
  role membership_role
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT organization_id, role
  FROM invitations
  WHERE email = p_email
    AND accepted_at IS NULL
    AND revoked_at IS NULL
    AND expires_at > now()
  ORDER BY created_at DESC;
$$;

REVOKE ALL ON FUNCTION find_pending_invitation_by_email(text) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'retailos_app') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION find_pending_invitation_by_email(text) TO retailos_app';
  END IF;
END
$$;
