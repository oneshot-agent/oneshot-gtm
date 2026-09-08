# OneShot SDK integration package

`oneshot-agent-sdk-0.32.0.tgz` is built from the sibling OneShot repository's `libs/agent-sdk` with `bun run build` and `npm pack --workspace @oneshot-agent/sdk`. It contains the physical-mail SDK changes used by this branch, without requiring an npm publication or a machine-specific filesystem link.

Both core and the server depend on this archive so development and the server build resolve the same SDK. After publishing SDK 0.32.0, replace both file dependencies with that registry version, regenerate `bun.lock`, and remove the archive. Do not publish the GTM package with an unresolved relative file dependency.
