# Application release action

Build OCI images, push versioned images to GHCR, and request an application release from `app-deployer` over Tailscale. This JavaScript action runs on Node.js 24, with its bundled runtime committed in `dist/`.

The action talks to a self-hosted `app-deployer` service. The deployer authenticates GitHub OIDC identity and validates registered repositories, workflows, images, platforms, and revisions before writing infrastructure changes.

This repository is prepared for local review. No stable `v1` tag is published yet; pin a reviewed commit SHA until the end-to-end deployment has been accepted.

## Usage

Run from the source repository's `main` branch on a fresh Linux GitHub-hosted x64 or arm64 runner with Docker Buildx. Match the build platform to the runner architecture, or configure emulation before this step. The application and all components must already be registered in the deployer.

```yaml
name: Release
on:
  push:
    branches: [main]
  workflow_dispatch:
permissions:
  contents: read
  actions: read
  packages: write
  id-token: write
concurrency:
  group: release
  cancel-in-progress: false
jobs:
  release:
    runs-on: ubuntu-24.04-arm
    steps:
      - uses: actions/checkout@v7.0.1
      - uses: CorrectRoadH/app-release-action@<reviewed-commit-sha>
        with:
          app: reader
          tailscale-client-id: ${{ vars.APP_RELEASE_TS_CLIENT_ID }}
          tailscale-audience: ${{ vars.APP_RELEASE_TS_AUDIENCE }}
          deployer-url: ${{ vars.APP_RELEASE_DEPLOYER_URL }}
          components: |
            - name: api
              dockerfile: api/Dockerfile
            - name: web
              dockerfile: web/Dockerfile
              target: runtime
```

`APP_RELEASE_TS_CLIENT_ID` and `APP_RELEASE_TS_AUDIENCE` are public repository variables for the dedicated application-release OIDC trust credential. Both inputs are required when `deploy=true`; missing values fail before building. The token defaults to `${{ github.token }}`; no long-lived secret is required. GHCR packages must grant Actions access to the source repository.

The permissions allow checking out source and reading commit timestamps (`contents: read`), reading run and current-job timestamps (`actions: read`), pushing the source repository's packages (`packages: write`), and requesting short-lived OIDC identities (`id-token: write`).

## Inputs

| Input                 | Default                      | Meaning                                                                                        |
| --------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------- |
| `app`                 | Required                     | Registered application name, lowercase letters, digits and hyphens                             |
| `components`          | Required                     | YAML list of components                                                                        |
| `platform`            | `linux/arm64`                | Single platform matching deployment registration                                               |
| `image-prefix`        | `ghcr.io/<repository owner>/<app>` | Repository prefix; normally use the registered value                                           |
| `deployer-url`        | None                         | Deployer HTTP(S) origin reachable through the Tailnet; required for deployment |
| `network`             | `tailscale`                  | `tailscale` joins the Tailnet with OIDC; `direct` skips it when the runner already reaches the deployer (for example an in-cluster runner) |
| `tailscale-client-id` | None                         | Public OIDC client ID; required for deployment                                                 |
| `tailscale-audience`  | None                         | Public OIDC audience; required for deployment                                                  |
| `github-token`        | `${{ github.token }}`        | Repository token for GHCR and metadata APIs                                                    |
| `upstream-revision`   | None                         | Full upstream source SHA; separate from the workflow repository revision                       |
| `deploy`              | `true`                       | Set to `false` to build, push, and record without joining Tailscale or contacting the deployer |
| `timeout`             | `15m`                        | Deployment request and polling deadline, up to `24h`; e.g. `30s`, `15m`, `1h`                  |

Each component has `name`, optional `context` (default `.`), `dockerfile` (default `<context>/Dockerfile`), `target`, and multiline `build-args` (`KEY=VALUE`). Do not pass credentials through build arguments or image labels.

Images use `<image-prefix>-<component>`, except a single component named `app`, which uses `<image-prefix>`. Tags are `<UTC year>.<month>.<day>-<run_number>.<run_attempt>`, without date zero padding. Existing tags are rejected; reruns get a new attempt number. GHCR tags should only be written by the authorized release workflow.

Every image carries `org.opencontainers.image.revision` (the workflow repository SHA), `source`, `version`, and `created` labels. `io.github.correctroadh.app-release-action.upstream-revision` is included only when supplied; it never replaces the workflow repository revision.

## Outputs and records

| Output         | Meaning                                                                   |
| -------------- | ------------------------------------------------------------------------- |
| `version`      | Generated version tag                                                     |
| `release-id`   | Release identifier; empty when `deploy=false`                             |
| `status`       | `healthy`, `noop`, `superseded`, `failed`, or `built` for build-only runs |
| `infra-commit` | Deployer write-back commit, or empty before write-back                    |
| `digests`      | JSON object mapping component names to pushed SHA-256 digests             |
| `record`       | `$RUNNER_TEMP/app-release/record.json`                                    |

`healthy` and `noop` succeed. `built` succeeds when `deploy=false`. Superseded releases, failures, API errors, and timeouts fail the step. Failure records contain the error code and phase. Unreached timestamps and durations are `null`.

The action uploads `app-release-record` (14-day retention) and adds version, final status, infrastructure commit, stage durations, pushed bytes, reused layers, and failure details to `$GITHUB_STEP_SUMMARY`, including on failure. Artifact upload failure also fails the action. Download the artifact from the workflow run to inspect the complete `app-release/v1` record.

BuildKit cache hits and misses count unique completed rawjson vertices. Layer reuse comes from individual GHCR blob HEAD requests before pushing; only `404` means absent. `image_bytes` sums compressed manifest layer sizes; `pushed_bytes` sums missing compressed blobs, excluding config/manifest bytes and protocol overhead. Durations use the total first-start to last-finish spans for builds and pushes, so sequential multi-component spans include intervening work, as defined by the contract.

## Runtime and credentials

Each component exports an OCI directory using Buildx with GHA cache scope `<app>-<component>`, classifies compressed layers, then pushes using `regctl image copy`. The remote digest and layer descriptors are read back before deployment. Temporary OCI directories and the action-owned Buildx builder are cleaned up on success and failure; a post hook provides fallback cleanup after cancellation.

`regctl v0.11.7` Linux amd64/arm64 binaries are downloaded over HTTPS and checked against architecture-specific SHA-256 values committed in `src/tools.ts`. Registry authentication is passed in memory and subprocess arguments, with all subprocess output suppressed; the action does not run Docker/regctl login or write registry credentials to disk.

For deployment, this Node action downloads and verifies the official `tailscale/github-action v4.4.0` archive at commit `064b10558093f38325e838ddea35486bdc6b1d5c`, then executes its declared `dist/index.js` and `dist/logout/index.js` entrypoints under Node 24. This preserves the official OIDC handshake and ephemeral `tag:ci` daemon lifecycle while keeping the public action a JavaScript action. Tailscale itself is pinned to `1.104.5` with architecture-specific checksums. Deployment requires a fresh runner, passwordless sudo, and no existing Tailscale daemon. The official daemon uses in-memory state. Logs from both official entrypoints are suppressed even in debug mode to avoid echoing credentials.

The GitHub OIDC request credential is read only when requesting a token. Every deployer request obtains a new `aud=app-deployer` token; polling is every five seconds. Tokens are never added to records, summaries, or credential files. Artifact uploads also run in an isolated subprocess with SDK output suppressed, including debug and error messages. Untrusted process, network, and server error messages are replaced with an error code and phase so a remote service cannot echo bearer credentials into logs.

## Development and validation

```sh
npm ci
npm run lint
npm run typecheck
npm test
npm run build
npm run check-dist
# With actionlint v1.7.12 on PATH:
actionlint -shellcheck=''
```

CI runs these checks and verifies that committed bundles match source. `.github/workflows/e2e.yml` runs only through `workflow_dispatch`; it builds a minimal scratch image, pushes it with `deploy: false`, checks outputs and the record, and uploads the record. It does not request deployment. A deployment end-to-end workflow can be connected after the deployer is ready. Local tests fake Docker/regctl processes, tool installation, GHCR, GitHub API, the deployer, and OIDC rather than accessing production services.
