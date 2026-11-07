---
description: "Subprocess runtime for deployments whose task environment lives in another container, for maintainers whose tools spawn commands."
kind: "package-reference"
---

# @deepseek-ai/dsh-subprocess-remote

## Summary

`dsh-subprocess-remote` serves `ctx.subprocess` from the environment a benchmark service owns. Some tools are spawn-backed rather than filesystem-provider methods — `glob` and `grep` run `ripgrep` through this seam — so with a local runtime they search the harness's own filesystem and report "no such directory" for a path the task provides.

Every spawn is one command with a complete answer, so the handle is already settled. Pretending otherwise would let a caller wait for output that will never grow.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount this runtime in place of the local one when spawned commands must run where the task lives.

```yaml
- id: subprocess
  disabled: true

- id: subprocess-remote
  name: '@deepseek-ai/dsh-subprocess-remote'
  config:
    endpoint: http://terminalbench-pipeline:8080
    token: !!js 'process.env.PIPELINE_API_TOKEN?.trim()'
```

| Field | Meaning |
|---|---|
| `endpoint` | The service that owns the task containers. Required. |
| `token` | Bearer credential, sent as `Authorization`. Optional. |
| `timeoutSec` | Budget for one command. |

<a id="understand-the-implementation"></a>
## Understand the implementation

The spec's `agentId` names which task container the command belongs to; a spec without one is refused before anything is sent, because guessing would run the command against another case's task.

Argv is quoted for the container's shell one argument at a time, so a value containing a quote, a `$`, or a backtick reaches the program unchanged instead of being interpreted. The collected-output readers reflect the command's real streams once it answers.

`terminalEnvironment` reports the container's platform and shell; `spawnTerminal` refuses, because this runtime has no terminal to allocate and returning a handle that could never carry input would be worse than saying so.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- **No live process.** A spawn completes with its whole output; there is no incremental read while it runs.
- **No terminal.** Interactive programs cannot run through this runtime.
- **A lost service is a failed command.** Nothing is retried: a command with side effects must not run twice.
