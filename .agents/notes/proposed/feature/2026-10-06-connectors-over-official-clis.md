# Agent Note: Connectors over the platforms' official CLIs

Status: proposed

English | [中文](2026-10-06-connectors-over-official-clis.zh.md)

## Problem

Desktop users want the model to work in the office platforms their company runs on — Feishu and DingTalk first, WeCom later — the way comparable products offer "connectors": a card per platform, a `+` to install, a sign-in when needed, and a status dot. Each platform exposes hundreds of APIs that change often, needs its own OAuth flow, and acts with the user's own identity, so how DSH reaches a platform decides who maintains that surface, where its credentials live, and how a write the user did not intend is stopped.

## Proposal

A [connector](../../../../docs/glossary.md#connector) is the platform's **unmodified official CLI** — `lark-cli` (larksuite/cli) for Feishu and `dws` (DingTalk-Real-AI/dingtalk-workspace-cli) for DingTalk — plus the Skills that CLI ships. The model runs the CLI through the existing shell tool and learns it from those Skills; DSH registers no per-operation tools.

- **Pinned versions.** Each DSH release pins every CLI version and checksum; DSH downloads it the way the embedding runtime is downloaded (npmmirror, then npmjs) and upgrades it only with DSH.
- **Shared program, per-tenant sign-in.** One CLI program serves the machine. Each [hub sign-in](../../../../docs/glossary.md#skill-hub) tenant gets its own CLI configuration directory (`LARKSUITE_CLI_CONFIG_DIR`, `DWS_CONFIG_DIR`), so DSH never reads or changes the user's own `~/.lark-cli` or `~/.dws`. `dws` also keeps its credential-store key in the system keychain under one name for every directory and sweeps that name when signing out, so DSH runs it with `DWS_KEYCHAIN_DIR` in the tenant's directory and `DWS_DISABLE_KEYCHAIN=1`; on Windows, where `dws` uses the user's registry instead, DingTalk is unsupported.
- **Sign-in follows each CLI's agent flow.** Feishu runs `config init --new` (the user creates their own app in the browser) and then `auth login --recommend`; DingTalk runs `auth login` with its official app. DSH shows each verification link and QR code in a dialog and opens the browser.
- **Writes are confirmed through `user-approval`.** For Feishu, DSH reads each command's official risk level: `read` runs, `write` asks every time, and `high-risk-write` asks with a stronger warning before DSH adds `--yes`. For DingTalk, DSH reads the `Safety:` line `dws` states in each command's help (`effect=read|write|destructive`, `risk`, `confirmation`): reads run, other commands ask, destructive or high-risk ones ask with the stronger warning, and DSH adds `--yes` to a command whose confirmation the user must give. A short DSH list covers read-only utility commands that state no safety, such as `auth status`. A command whose risk cannot be determined is treated as a write. (This replaces the read-only allowlist planned while `dws` was thought to carry no risk metadata.)
- **Status comes from the CLI.** `auth status --json` (Feishu) and `auth status --readonly --format json` (DingTalk) drive the [connector status](../../../../docs/glossary.md#connector-status).

## Alternatives considered

### Why not dedicated tools per operation?

Registering tools such as `feishu_send_message` would make each operation's schema and risk explicit, but DSH would then own hundreds of operations across platforms and chase every API change. The official CLIs and their Skills already cover messages, documents, calendars, approvals, sheets, and more, and their vendors maintain them.

### Why not MCP?

Neither CLI documents an MCP server mode, and a vendor MCP server would still need DSH-side installation, sign-in, and per-tenant isolation. MCP stays the route for user-added custom servers, not for these built-in connectors.

### Why not a custom-built Feishu CLI?

larksuite/cli supports embedding through a wrapper `main` that replaces the credential source, intercepts requests, and restricts commands, which would give DSH a native approval gate. It would also make DSH the distributor of its own Feishu binary, with its own build, signing, and upgrade duty, while the unmodified CLI already exposes the risk levels DSH needs.

### Why not a tenant app configured in the user center?

The unmodified Feishu CLI reads an app id and secret from environment variables, so an administrator could configure one app per tenant and spare each employee the app-creation step. It needs user-center changes and sends the app secret to every client; it is deferred to its own spec and becomes necessary when a company forbids employees from creating apps.

## Acceptance criteria

- Installing a connector downloads the pinned CLI, verifies its checksum, and signs in without touching the user's own CLI configuration.
- A connected, enabled connector's Skills reach the model in every session; a disabled or signed-out one contributes nothing.
- A Feishu or DingTalk command that does not only read runs only after the user approves that one call, and the request and outcome are in the session's audit log.

## Risks

- **The shell is the boundary.** The model reaches a CLI through the shell tool, so approval depends on recognizing the CLI invocation; a command hidden behind a script or another program escapes the risk check unless the shell policy also blocks it.
- **Upstream changes.** Risk levels, flags, and Skill content follow the pinned version; every upgrade has to re-check how each CLI states risk in its help and DSH's list of DingTalk utility commands.
- **App creation can be forbidden.** A company that blocks self-built Feishu apps cannot use the Feishu connector until the tenant-app alternative ships.
- **WeCom is not covered.** Its CLI's configuration isolation, status output, and sign-in identity are unverified, so WeCom waits for a separate investigation.
