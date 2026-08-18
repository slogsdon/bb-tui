# Contributor Setup README Design

**Date:** 2026-08-17
**Status:** Approved for implementation

## Goal

Make the repository documentation sufficient for a contributor to install and
run the current source-only bb-tui development build without relying on
`DESIGN.md`, host-specific knowledge, or unreleased distribution plans.

## Audience and scope

The primary audience is a contributor working from a repository clone. The
documentation will cover the current path-installed bb plugin and the Ink
client executed from TypeScript source. Packaged binary installation is not
implemented and will be labeled as unavailable rather than documented as a
working path.

## Documentation structure

The root `README.md` will be authoritative and organized in this order:

1. Current development status and limitations.
2. Prerequisites: Node.js 20+, npm, and a same-host bb server version 0.38 or
   newer.
3. Copy-paste first-time setup from the repository root using `npm ci` in both
   package directories.
4. Path-based plugin installation and verification with `bb tui info`.
5. Interactive client startup with `npm run dev`.
6. The normal development loop, including plugin reloads after backend edits.
7. Tests, typechecking, headless CLI commands, configuration, and concise
   troubleshooting.
8. Current capabilities, repository layout, and links to deeper design notes.

The plugin `README.md` will stop presenting generic scaffold guidance. It will
identify the directory as the server-side component, link to the root setup,
and retain only plugin-specific install, reload, configuration, type-sync, and
build notes that are valid for the current source tree.

## Content decisions

- Use `npm ci` because both packages include committed lockfiles.
- Use repository-relative commands so the sequence works from a fresh clone.
- Describe the project as source-only until a bundled client artifact exists.
- Remove the host-specific Pi provider catalog note because it is unrelated to
  installing or contributing to bb-tui.
- Distinguish the bb CLI version from the bb server compatibility requirement;
  the plugin manifest requires bb server `>=0.38` and plugin SDK `>=0.4.6`.
- Preserve the verified responsive-layout and terminal-compatibility notes,
  while retaining the explicit limitation that Termius is not device-verified.

## Verification

Implementation is complete only when:

1. Every documented npm script exists in the corresponding `package.json`.
2. `npm ci` succeeds in both package directories.
3. Client tests and typechecking pass.
4. Plugin TypeScript typechecking passes.
5. `bb tui info` succeeds with the path-installed plugin.
6. The documented command sequence is internally consistent when read from a
   repository-root starting directory.
7. Searches find no remaining claim that a bundled binary or install script is
   currently available.

## Non-goals

- Packaging or publishing a client binary.
- Marketplace, Git, or npm installation instructions.
- Supporting remote bb servers.
- Changing application behavior or dependencies.
