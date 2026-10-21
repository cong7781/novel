# Security

## What this package does with credentials

The **plugin half** (`lib/index.js`, the in-conversation card) never touches a credential: it calls
the host's own model route (`ctx.llm` + `ctx.agentDefaultModel`), so the model choice and the key
belong to the DSH installation, not to this package.

The **standalone viewer/CLI** (`scripts/serve.mjs`, `scripts/extract-cli.mjs`) does read a
DeepSeek key, in this order:

1. `DEEPSEEK_API_KEY` from the environment;
2. the `DEEPSEEK_API_KEY` entry in `~/.dsh/.credentials.yaml` (the file DSH itself writes).

The key is read inside the process, used as an `Authorization` header, and never logged, echoed into
a response, or written into a run artifact. `scripts/serve.mjs` binds `127.0.0.1` only and has no
authentication of its own — anyone who can reach loopback on that machine can start extractions on
that key, so do not expose the port.

## Reporting

Open a GitHub issue for anything that looks like a credential leak or a path traversal in the
viewer server. Do not paste a key into an issue.
