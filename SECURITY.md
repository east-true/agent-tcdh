# Security policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately. Check the repository's [Security tab](https://github.com/east-true/agent-tcdh/security) for a **Report a vulnerability** option. Private reporting is not enabled on this repository as of 2026-10-27. Until a private channel is available, open an issue requesting a private reporting channel without including vulnerability details, exploit code, credentials, or sensitive logs.

Include the affected commit or version, Node version, operating system, deployment configuration with secrets removed, reproduction steps, impact, and a minimal proof of concept in the private report. Ordinary bugs can use the public bug-report form.

## Deployment and trust boundaries

AgentTCDH stores connection metadata and exposes discovery interfaces. Consumers connect to targets directly. Registering a target is not a verification of its trustworthiness, execution behavior, or authorization.

Use the separate administrator and read-token settings described in the [README](README.md#storage-authentication-and-deployment). Keep actual provider credentials in the consuming environment; registrations should contain credential references. Review discovered stdio commands before allowing a consumer to execute them.

When reporting discovery or authentication problems, identify whether the behavior occurs in the hub, the consuming agent, or the target provider. Include the protocol binding/version where applicable. Existing [verification reports](docs/platform-compatibility.md) describe tested environments, not a guarantee for every deployment or external target.
