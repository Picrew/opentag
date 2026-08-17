ALTER TABLE cp_session
  ADD COLUMN organization_id text;

UPDATE cp_session session
SET organization_id = (
  SELECT candidate.organization_id
  FROM cp_membership candidate
  WHERE candidate.operator_id = session.operator_id
  ORDER BY candidate.organization_id
  LIMIT 1
);

ALTER TABLE cp_session
  ALTER COLUMN organization_id SET NOT NULL;

ALTER TABLE cp_session
  ADD CONSTRAINT cp_session_membership_fk
  FOREIGN KEY (organization_id, operator_id)
  REFERENCES cp_membership(organization_id, operator_id);
