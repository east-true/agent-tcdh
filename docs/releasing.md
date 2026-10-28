# Releasing AgentTCDH

## Prepare a version

Update `package.json`, the lockfile, protocol/OpenAPI version metadata, `CHANGELOG.md`, and `docs/releases/vX.Y.Z.md` together. Release scripts currently accept stable `vX.Y.Z` tags only. Submit changes through a PR and wait for all required native and container checks before merging to `main`.

Create and push the version tag at the verified main commit. The `release.yml` workflow reruns the native/container suite, requires the tag to match the package version on main history, builds an installable tarball, verifies that exact artifact in isolation, and publishes a GitHub release with `SHA256SUMS` and `release.json`. Source archives alone do not contain the built CLI.

For local preparation from a clean committed checkout:

```sh
npm ci --ignore-scripts
npm run check
npm run release:prepare -- --tag v0.1.0
npm run release:verify -- --tag v0.1.0
```

`release:prepare` requires a new output directory and does not replace existing assets. `release:verify` rejects mismatched source commits, versions, filenames, and checksums, then installs the supplied tarball and verifies its CLI, discovery protocols, persistence, and direct-call demo. Use `--out` / `--directory` for alternate artifact locations. The workflows do not call external providers or models.

## Publish to npm

The initial package must be created by an authorized npm account. Download and verify the published GitHub assets from their tagged source checkout, then publish the exact tarball:

```sh
npm login
npm publish release/agent-tcdh-0.1.0.tgz --access public --ignore-scripts
```

Keep account authentication outside the repository. Complete any npm account/2FA requirements in npm's official flow. Do not overwrite a published version; fix problems in a new version.

For subsequent releases, configure the package's **Trusted Publisher** on npm with GitHub owner `jiind`, repository `agent-tcdh`, and workflow filename `publish-npm.yml` (no environment name). Then run that workflow from the `main` branch with the published release tag. It downloads the GitHub assets, verifies their source identity and installed behavior, and publishes the same tarball using OIDC. It needs no stored npm token. This workflow requires the external npm trust configuration; merely committing the workflow does not enable it. See [npm's trusted publishing documentation](https://docs.npmjs.com/trusted-publishers/).

Verify the public registry version, `latest` tag, package integrity, and `npx --yes agent-tcdh@0.1.0 --help` after first publication. The GitHub release and npm registry are separate destinations; record their actual status separately.
