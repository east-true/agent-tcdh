# Security policy

## Reporting a vulnerability

Please report suspected vulnerabilities through the repository's [private vulnerability reporting form](https://github.com/jiind/agent-tcdh/security/advisories/new). Do not include vulnerability details, exploit code, credentials, or sensitive logs in public issues.

Include the affected commit or version, Node version, operating system, deployment configuration with secrets removed, reproduction steps, impact, and a minimal proof of concept in the private report. Ordinary bugs can use the public bug-report form.

## Deployment and trust boundaries

AgentTCDH stores connection metadata and exposes discovery interfaces. Consumers connect to targets directly. Registering a target is not a verification of its trustworthiness, execution behavior, or authorization.

Use the separate administrator and read-token settings described in the [README](README.md#storage-authentication-and-deployment). Keep actual provider credentials in the consuming environment; registrations should contain credential references. Review discovered stdio commands before allowing a consumer to execute them.

When reporting discovery or authentication problems, identify whether the behavior occurs in the hub, the consuming agent, or the target provider. Include the protocol binding/version where applicable. Existing [verification reports](docs/platform-compatibility.md) describe tested environments, not a guarantee for every deployment or external target.
