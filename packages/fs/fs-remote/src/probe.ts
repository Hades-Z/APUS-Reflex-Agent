/**
 * The program that runs inside the task container to serve one filesystem call.
 *
 * The harness cannot reach the task's files, so each operation is a short
 * Python program executed through the same channel the shell uses. One
 * program per call keeps the protocol to "send a script, read a JSON answer",
 * with no helper process to install in the container and no long-lived
 * session to leak.
 *
 * The program prints exactly one JSON object on stdout. Errors travel in
 * that object rather than as a non-zero exit, so a failure the caller can act
 * on ("not found", "not text") is distinguishable from the container being
 * unreachable.
 *
 * @module @deepseek-ai/dsh-fs-remote/probe
 */

/** What one probe call asks the container to do. */
export interface ProbeRequest {
  op: 'resolve' | 'stat' | 'lstat' | 'read' | 'list' | 'write' | 'edit' | 'bytes' | 'range'
  path: string
  /** Working directory a relative path resolves against. */
  cwd?: string
  /** Full replacement text, for `write`. */
  content?: string
  /** Literal edit, for `edit`. */
  old?: string
  new?: string
  replaceAll?: boolean
  /** Byte budget, for `bytes`. */
  maxBytes?: number
  /** Byte window, for `range`. */
  offset?: number
  length?: number
  /** Expected version, for a guarded write or edit. */
  expectedVersion?: string
  /** Whether `write` may only create. */
  createOnly?: boolean
}

/** What the probe answered. */
export interface ProbeAnswer {
  ok?: boolean
  code?: string
  message?: string
  version?: string
  type?: 'file' | 'directory' | 'other'
  size?: number
  text?: string
  base64?: string
  entries?: Array<{ name: string; type: 'file' | 'directory' | 'other'; version: string; size?: number }>
  operation?: 'create' | 'update'
  before?: string | null
  after?: string
  /** Canonical path the probe resolved. */
  path?: string
  /** Whether the target exists, for resolve/stat/lstat. */
  exists?: boolean
}

/**
 * The probe program.
 *
 * It reads one JSON request from argv, performs exactly one operation, and
 * prints one JSON answer. Version tokens are the file's mtime in nanoseconds
 * plus its size: stable for an unchanged file and different after a write,
 * which is all a staleness guard needs.
 */
export const PROBE_SOURCE = String.raw`
import base64, hashlib, json, os, stat, sys

def version(p):
    st = os.stat(p)
    return "%d:%d" % (st.st_mtime_ns, st.st_size)

def kind(p):
    try:
        st = os.lstat(p)
    except OSError:
        return "other"
    if stat.S_ISDIR(st.st_mode):
        return "directory"
    if stat.S_ISREG(st.st_mode):
        return "file"
    return "other"

def need(p):
    if not os.path.exists(p):
        fail("FS_NOT_FOUND", "not found: " + p)
    return p

def fail(code, message):
    print(json.dumps({"ok": False, "code": code, "message": message}))
    sys.exit(0)

def run(req):
    op = req["op"]
    path = req.get("path") or "."
    cwd = req.get("cwd")
    full = path if os.path.isabs(path) else os.path.abspath(os.path.join(cwd or os.getcwd(), path))

    if op == "resolve" or op == "stat":
        if not os.path.exists(full):
            return {"ok": True, "path": os.path.abspath(full), "exists": False}
        return {"ok": True, "path": os.path.abspath(full), "version": version(full),
                "type": kind(full), "size": os.stat(full).st_size}

    if op == "lstat":
        if not os.path.lexists(full):
            return {"ok": True, "exists": False}
        return {"ok": True, "path": os.path.abspath(full), "version": version(full),
                "type": kind(full), "size": os.lstat(full).st_size}

    if op == "read":
        need(full)
        try:
            with open(full, "rb") as f:
                raw = f.read()
        except PermissionError:
            fail("FS_PERMISSION_DENIED", "permission denied: " + full)
        try:
            return {"ok": True, "text": raw.decode("utf-8"), "version": version(full)}
        except UnicodeDecodeError:
            fail("FS_NOT_TEXT", "not UTF-8 text: " + full)

    if op == "bytes":
        need(full)
        limit = int(req.get("maxBytes") or 0)
        with open(full, "rb") as f:
            raw = f.read(limit if limit > 0 else -1)
        return {"ok": True, "base64": base64.b64encode(raw).decode("ascii"), "version": version(full)}

    if op == "range":
        need(full)
        offset = int(req.get("offset") or 0)
        length = int(req.get("length") or 0)
        with open(full, "rb") as f:
            f.seek(offset)
            raw = f.read(length)
        return {"ok": True, "base64": base64.b64encode(raw).decode("ascii")}

    if op == "list":
        need(full)
        if not os.path.isdir(full):
            fail("FS_NOT_DIRECTORY", "not a directory: " + full)
        out = []
        with os.scandir(full) as it:
            for entry in sorted(it, key=lambda e: e.name):
                child = os.path.join(full, entry.name)
                try:
                    out.append({"name": entry.name, "type": kind(child),
                                "version": version(child), "size": entry.stat().st_size})
                except OSError:
                    out.append({"name": entry.name, "type": "other", "version": ""})
        return {"ok": True, "entries": out}

    if op == "write":
        expected = req.get("expectedVersion")
        existed = os.path.exists(full)
        if req.get("createOnly") and existed:
            fail("FS_STALE_VERSION", "file already exists: " + full)
        before = None
        if existed:
            if expected is not None and version(full) != expected:
                fail("FS_STALE_VERSION", "the file changed since it was read: " + full)
            try:
                with open(full, "rb") as f:
                    before = f.read().decode("utf-8")
            except (OSError, UnicodeDecodeError):
                before = None
        os.makedirs(os.path.dirname(full) or ".", exist_ok=True)
        with open(full, "w", encoding="utf-8", newline="\n") as f:
            f.write(req.get("content") or "")
        return {"ok": True, "operation": "update" if existed else "create",
                "before": before, "version": version(full)}

    if op == "edit":
        need(full)
        if not os.path.isfile(full):
            fail("FS_NOT_REGULAR_FILE", "not a regular file: " + full)
        expected = req.get("expectedVersion")
        if expected is not None and version(full) != expected:
            fail("FS_STALE_VERSION", "the file changed since it was read: " + full)
        with open(full, "r", encoding="utf-8", newline="") as f:
            before = f.read()
        old = req.get("old") or ""
        new = req.get("new") or ""
        count = before.count(old)
        if count == 0:
            fail("FS_EDIT_NOT_FOUND", "the text to replace does not appear in " + full)
        if count > 1 and not req.get("replaceAll"):
            fail("FS_AMBIGUOUS_EDIT", "the text to replace appears %d times; pass replaceAll" % count)
        after = before.replace(old, new) if req.get("replaceAll") else before.replace(old, new, 1)
        with open(full, "w", encoding="utf-8", newline="") as f:
            f.write(after)
        return {"ok": True, "before": before, "after": after, "version": version(full)}

    fail("FS_IO_ERROR", "unknown operation: " + op)

try:
    result = run(json.loads(base64.b64decode(sys.argv[2]).decode("utf-8")))
    print(json.dumps(result))
except SystemExit:
    raise
except Exception as error:
    print(json.dumps({"ok": False, "code": "FS_IO_ERROR",
                      "message": type(error).__name__ + ": " + str(error)}))
`

/** Wrap one request as a shell command that runs the probe. */
export function probeCommand(request: ProbeRequest): string {
  const payload = JSON.stringify(request)
  // Both the program and the request travel base64-encoded, so no shell
  // metacharacter in a path or a file body can change what the container
  // runs. Decoding happens inside python, not in the shell.
  const requestB64 = Buffer.from(payload, 'utf8').toString('base64')
  const scriptB64 = Buffer.from(PROBE_SOURCE, 'utf8').toString('base64')
  return `python3 -c 'import base64,sys;exec(base64.b64decode(sys.argv[1]))' '${scriptB64}' '${requestB64}'`
}
