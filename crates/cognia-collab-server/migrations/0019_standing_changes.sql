-- ADR-0253 §2 and §4: standing changes Hosts follow, and organization
-- suspension.

-- One row per mutation that can reduce or change a person's standing, written
-- in the mutation's own transaction. Writers take
-- `pg_advisory_xact_lock(hashtextextended('cognia.collab.standing_changes', 0))`
-- before inserting, so a row's sequence is allocated and committed in order:
-- a reader that has seen sequence N has seen every committed row below it.
CREATE TABLE IF NOT EXISTS standing_changes (
    seq          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    org_id       text   NOT NULL,
    -- Absent for organization-wide kinds.
    user_id      text,
    workspace_id text,
    kind         text   NOT NULL CHECK (kind IN
        ('offboarded', 'role_changed', 'workspace_removed', 'org_suspended', 'org_resumed')),
    created_at   bigint NOT NULL,
    CHECK ((kind IN ('org_suspended', 'org_resumed')) = (user_id IS NULL)),
    CHECK ((kind = 'workspace_removed') = (workspace_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS standing_changes_created_at ON standing_changes (created_at);

ALTER TABLE standing_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE standing_changes FORCE  ROW LEVEL SECURITY;

-- The mutation writes inside its own tenant scope.
DROP POLICY IF EXISTS standing_changes_tenant_isolation ON standing_changes;
CREATE POLICY standing_changes_tenant_isolation ON standing_changes
    USING      (org_id = nullif(current_setting('app.tenant_id', true), ''))
    WITH CHECK (org_id = nullif(current_setting('app.tenant_id', true), ''));

-- The internal stream reads across organizations and filters each row by the
-- requesting credential's scope; retention deletes across organizations.
-- Neither may write a row.
DROP POLICY IF EXISTS standing_changes_stream_read ON standing_changes;
CREATE POLICY standing_changes_stream_read ON standing_changes FOR SELECT
    USING (nullif(current_setting('app.standing_stream', true), '') IN ('read', 'prune'));
DROP POLICY IF EXISTS standing_changes_retention ON standing_changes;
CREATE POLICY standing_changes_retention ON standing_changes FOR DELETE
    USING (nullif(current_setting('app.standing_stream', true), '') = 'prune');

-- The highest sequence retention has removed. A cursor below it cannot be
-- answered with rows and gets a `resync` frame instead.
CREATE TABLE IF NOT EXISTS standing_change_retention (
    id             smallint PRIMARY KEY CHECK (id = 1),
    pruned_through bigint   NOT NULL DEFAULT 0
);
INSERT INTO standing_change_retention (id, pruned_through) VALUES (1, 0) ON CONFLICT (id) DO NOTHING;

-- Deployment state, deliberately outside tenant RLS: only the deployment
-- operator suspends or resumes an organization. The migrator revokes
-- application writes after its blanket grants on every boot, so an
-- organization owner cannot lift their own suspension.
CREATE TABLE IF NOT EXISTS org_suspensions (
    org_id       text PRIMARY KEY,
    suspended_at bigint NOT NULL,
    suspended_by text   NOT NULL,
    reason       text   NOT NULL CHECK (length(reason) BETWEEN 1 AND 1024)
);

CREATE TABLE IF NOT EXISTS org_suspension_audit (
    id           uuid   PRIMARY KEY,
    org_id       text   NOT NULL,
    action       text   NOT NULL CHECK (action IN ('suspend', 'resume')),
    principal    text   NOT NULL,
    reason       text   NOT NULL CHECK (length(reason) BETWEEN 1 AND 1024),
    operation_id text   NOT NULL UNIQUE,
    created_at   bigint NOT NULL
);

CREATE OR REPLACE FUNCTION org_suspension_audit_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'org_suspension_audit is append-only';
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger
        WHERE tgrelid = 'org_suspension_audit'::regclass
          AND tgname = 'org_suspension_audit_append_only') THEN
        CREATE TRIGGER org_suspension_audit_append_only
        BEFORE UPDATE OR DELETE OR TRUNCATE ON org_suspension_audit
        FOR EACH STATEMENT EXECUTE FUNCTION org_suspension_audit_append_only();
    END IF;
END $$;
