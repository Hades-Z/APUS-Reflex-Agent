---
description: "Filesystem provider for deployments whose task files live in another container, for maintainers wiring a benchmark trial to its task service."
kind: "package-reference"
---

# @deepseek-ai/dsh-fs-remote

## Summary

`dsh-fs-remote` serves `ctx.fs` from the environment a benchmark service owns. A benchmark trial can hand its work to this harness, but the files it asks about — the repository being fixed, the data being parsed — live in a container this process never touches. A local provider would answer about the harness's own filesystem, so every operation runs a short program in the task container and returns its real answer.

The target key carries the agent as well as the path. One harness process serves several concurrent cases, and the service needs that identity to tell which container a path belongs to; consumers treat the key as opaque, which makes it a safe place to keep it.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount this provider instead of a local one when the task's files are not on this host.

```yaml
- id: fs-sandbox
  disabled: true          # one filesystem provider may be loaded

- id: fs-remote
  name: '@deepseek-ai/dsh-fs-remote'
  config:
    endpoint: http://terminalbench-pipeline:8080
    token: !!js 'process.env.PIPELINE_API_TOKEN?.trim()'
```

| Field | Meaning |
|---|---|
| `endpoint` | The service that owns the task containers. Required. |
| `token` | Bearer credential, sent as `Authorization`. Optional. |
| `timeoutSec` | Budget for one operation. |

Each operation is a `POST <endpoint>/jobs/by-session/<agentId>/exec` whose command runs a Python program in the task container. Program and request travel base64-encoded, so neither a path nor a file body can change the command the container runs.

<a id="understand-the-implementation"></a>
## Understand the implementation

Every operation is one program invocation: read, stat, list, write, edit, bytes or a byte range. The program prints one JSON answer; a failure the caller can act on — a missing file, text that does not match, a changed version — arrives as a code inside that answer, while a container that never replied throws. The two are different facts and stay distinguishable.

Version tokens are the file's modification time in nanoseconds plus its size. That is stable for an unchanged file and different after a write, which is all a staleness guard needs.

`lstat` is refused. It is path-shaped, so it carries no agent, and guessing which container a bare path belongs to would answer about the wrong task. Its callers are UI and persistence paths that never run against a task environment.

<a id="model-experience"></a>
## Model Experience

The model sees the same `read`, `write`, `edit`, `glob` and `grep` tools with the same result shapes; what changes is where the files are. A path the task provides resolves here and would be absent against the harness's own filesystem.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- **No watching.** `watch` inherits the base refusal; a task trial does not need change notifications.
- **One round trip per operation.** A large `grep` is many small reads rather than a streamed search inside the container.
- **A lost service is a failed operation.** Nothing is retried: a write must not happen twice.
