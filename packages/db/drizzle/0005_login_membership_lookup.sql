-- Login needs to find a user's membership(s) across ALL organizations (keyed by user_id, not
-- organization_id) to determine which org to log them into — but memberships has FORCE ROW LEVEL
-- SECURITY requiring app.current_org_id to already be set, which is a chicken-and-egg problem
-- before an org has been chosen. A SECURITY DEFINER function is a narrow, explicit, single-purpose
-- exception: it runs with the privileges of its owner (the migration role), bypassing RLS for
-- exactly this one query, while retailos_app only ever gets EXECUTE on the function itself, never
-- raw unscoped SELECT on memberships. Every other membership query still goes through the normal
-- RLS-protected path once an organization_id is known.
--
-- Only accepted memberships (accepted_at IS NOT NULL) are returned — a pending invite is not a
-- valid login target.
CREATE FUNCTION find_accepted_memberships_for_login(p_user_id uuid)
RETURNS TABLE (
  id uuid,
  organization_id uuid,
  role membership_role,
  store_ids uuid[],
  approval_limit numeric(19, 4)
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT m.id, m.organization_id, m.role, m.store_ids, m.approval_limit
  FROM memberships m
  WHERE m.user_id = p_user_id
    AND m.accepted_at IS NOT NULL
    AND m.deleted_at IS NULL;
$$;

-- REVOKE + explicit GRANT rather than relying on default privileges: this function deliberately
-- bypasses RLS, so its execute permission must be an intentional, visible grant, not an ambient
-- consequence of retailos_app's default table/function privileges.
REVOKE ALL ON FUNCTION find_accepted_memberships_for_login(uuid) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'retailos_app') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION find_accepted_memberships_for_login(uuid) TO retailos_app';
  END IF;
END
$$;
