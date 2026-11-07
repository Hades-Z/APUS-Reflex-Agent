---
description: "Bash executor for deployments whose task environment lives in another container, for maintainers wiring a benchmark trial to its task service."
kind: "package-reference"
---

# @deepseek-ai/dsh-bash-remote

## Summary

`dsh-bash-remote` runs every Bash command in the environment a benchmark service owns. A benchmark trial can hand its work to this harness, but the task's files — the repository being fixed, the dataset being queried — live in a container this process never touches. Running `bash` locally would answer about the harness's own filesystem, which is why this executor sends each command to the service that holds the task and returns its real output.

The request names the agent, because one harness process serves several concurrent cases and the service needs that identity to tell which environment a command belongs to. Only foreground commands are served: a background command needs a process handle this executor cannot vouch for.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount this executor instead of a local one when commands must run where the task lives. It registers as `ctx.shell`, and the model-facing `bash` tool works over it unchanged: an agent calls the tool, and the command runs in the task environment.

```yaml
- id: bash-sandbox
  disabled: true          # one shell implementation may be loaded

- id: bash-remote
  name: '@deepseek-ai/dsh-bash-remote'
  config:
    endpoint: http://terminalbench-pipeline:8080
    token: !!js 'process.env.PIPELINE_API_TOKEN?.trim()'
```

| Field | Meaning |
|---|---|
| `endpoint` | The service that owns the task environments. Required. |
| `token` | Bearer credential, sent as `Authorization`. Optional. |
| `timeoutMs` | Default command budget. |
| `maxTimeoutMs` | Cap on a caller's own `timeoutMs`. |
| `cwd` | Working directory when the caller names none. |

Each command is a `POST <endpoint>/jobs/by-session/<agentId>/exec` carrying `command`, `workdir` and `timeout_sec`; the service answers `{stdout, stderr, return_code}`.

<a id="understand-the-implementation"></a>
## Understand the implementation

The executor resolves a request the same way a local one does — filling the working directory, clamping the timeout — and then sends it over HTTP. It holds no process, so the handle it returns is already settled: `result()` carries the answer and `readOutput()` has nothing left to read.

A command whose request names no agent is refused before anything is sent. Guessing an environment would run the command against another case's task and return a confidently wrong answer.

A non-zero exit code is the command's outcome, not an executor failure: `cat missing` reports exit 2 with its stderr, exactly as it would locally. A service that answers with an error status is an infrastructure failure and throws.

<a id="model-experience"></a>
## Model Experience

The model sees the same `bash` tool and the same result shape as with a local executor; what changes is where the command runs. Standard output, standard error and the exit code come from the task environment, so a command that reads a file the task provides succeeds here and would fail against the harness's own filesystem.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- **Background commands are not served.** `onExpiry: 'none'` throws. A real background handle needs the service to expose a live process, which it does not.
- **Output is bounded at the service's answer.** There is no spill file, because the bytes arrived whole over one response.
- **A lost service is a failed command.** The executor does not retry: a command with side effects must not run twice.
