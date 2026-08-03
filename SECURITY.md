# Security Policy

## Supported versions

Security fixes target the latest release and the current `main` branch. Older releases may not receive backports. Upgrade to the latest release before reporting a problem that may already be fixed.

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/amplifthq/opentag/security/advisories/new) for suspected vulnerabilities. Do not open a public issue, discussion, or pull request containing vulnerability details.

Include the following when it is safe to do so:

- the affected version, commit, package, provider, or execution path;
- impact and the authorization or trust boundary that is crossed;
- minimal reproduction steps or a proof of concept;
- relevant sanitized logs, receipts, or stack traces;
- any known mitigations or conditions that prevent exploitation.

Never include live credentials, webhook secrets, private keys, private repository content, personal data, or unsanitized provider payloads. Revoke any credential that may have been exposed.

Maintainers will validate the report in the private advisory, coordinate remediation and disclosure there, and publish security-relevant release information when a fix is available. Public disclosure should wait until maintainers have confirmed a safe disclosure plan.

## Research guidelines

Keep testing within accounts, repositories, workspaces, and data you are authorized to use. Avoid privacy violations, service disruption, destructive actions, persistence, and access to other users' data. Stop testing and report privately if you encounter sensitive data or an authorization boundary you did not intend to cross.
