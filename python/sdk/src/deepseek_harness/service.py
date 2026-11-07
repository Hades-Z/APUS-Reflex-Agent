"""HTTP surface for driving this harness from another process.

An evaluator runs outside this container and needs to hand work in and read
results back over the network. The harness already speaks JSON-RPC to its own
child process, but that transport is stdio and assumes a local parent; this
module wraps the same SDK in a small HTTP server so the harness can be a
long-lived service that other containers address by URL.

Only the standard library is used: the SDK's dependency list is pydantic and
the runtime binary, and a web framework for four routes would be a new
platform choice this package does not otherwise make.

@module deepseek_harness.service
"""

from __future__ import annotations

import json
import math
import os
import threading
import uuid
from urllib.parse import urlsplit
from dataclasses import dataclass, field, replace
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable

from .api import DeepSeekHarness, DeepSeekHarnessConfig


@dataclass
class _Run:
    """One task the evaluator handed in, and what it has produced so far."""

    run_id: str
    task_id: str
    instruction: str
    session_id: str
    # The harness instance this run was bound to. Cancellation must reach the
    # same instance, which is not necessarily the deployment's own route.
    route: tuple[str, ...] = ()
    # Where this run reports its outcome, and the identity the caller knows it
    # by. Empty means the caller did not ask to be told.
    callback_url: str = ""
    request_id: str = ""
    event_url: str = ""
    case_id: str = ""
    run_user: str = ""
    # How many events this run has reported, which is the source sequence the
    # evaluator de-dupes and orders by.
    reported: int = 0
    result: dict[str, Any] | None = None
    error: str | None = None
    # ``none`` → ``cancelling`` → ``cancelled`` | ``cancel-failed``. Only a
    # confirmed stop may be published as ``cancelled``.
    cancel_state: str = "none"
    done: threading.Event = field(default_factory=threading.Event)

    @property
    def cancel_requested(self) -> bool:
        """Whether the run must withhold delivery and its own outcome."""
        return self.cancel_state != "none"


class _RunCancelled(Exception):
    """Internal signal: the run was cancelled before its prompt was delivered."""


# The per-run route fields, and the environment names the harness profile reads
# them from. Both are needed: ``initialize`` names the provider and model, while
# the profile's route (its gateway base URL and key) is read from the runtime
# subprocess environment. Setting only one would advertise a model the profile
# never reaches.
_ROUTE_FIELDS = ("model", "base_url", "api_key")
_ROUTE_ENV = {
    "model": "LLM_MODEL",
    "base_url": "LLM_BASE_URL",
    "api_key": "LLM_API_KEY",
}


def _route_env(route: dict[str, str]) -> dict[str, str]:
    return {_ROUTE_ENV[name]: value for name, value in route.items() if name in _ROUTE_ENV}


def _route_key(config: DeepSeekHarnessConfig) -> tuple[str, ...]:
    """Which route a harness belongs to, as the values that fix it at start.

    The model and endpoint are what the runtime cannot change after it
    initializes; the key is part of the same identity so two evaluations using
    different credentials never share a runtime.
    """
    return (
        config.provider,
        config.model,
        config.base_url or "",
        config.api_key or "",
    )


def _callback_url_from_task(task: dict[str, Any]) -> str:
    """Where this run reports its outcome, validated before the run starts.

    A malformed URL must fail the submission: a run that only discovers its
    callback is unusable at the end has already spent the whole task budget.
    """
    raw = task.get("callback_url")
    if raw is None:
        return ""
    if not isinstance(raw, str) or not raw.strip():
        raise ValueError("task.callback_url must be a nonempty string")
    url = raw.strip()
    parsed = urlsplit(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("task.callback_url must be an http(s) URL")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("task.callback_url must not carry credentials, a query or a fragment")
    return url


def _event_url_from_task(task: dict[str, Any]) -> str:
    """Where this run reports its events, validated before it starts."""
    raw = task.get("event_url")
    if raw is None:
        return ""
    if not isinstance(raw, str) or not raw.strip():
        raise ValueError("task.event_url must be a nonempty string")
    url = raw.strip()
    parsed = urlsplit(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("task.event_url must be an http(s) URL")
    return url


def _route_from_task(task: dict[str, Any]) -> dict[str, str]:
    """The model route one run asked for, rejecting values a run cannot carry.

    Validation happens here, before the run is registered: a malformed route
    must not produce a run that fails only after it starts.
    """
    llm = task.get("llm")
    if llm is None:
        return {}
    if not isinstance(llm, dict):
        raise ValueError("task.llm must be an object")
    route: dict[str, str] = {}
    for field in _ROUTE_FIELDS:
        value = llm.get(field)
        if value is None:
            continue
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"task.llm.{field} must be a nonempty string")
        route[field] = value.strip()
    base_url = route.get("base_url")
    if base_url is not None and not (
        base_url.startswith("http://") or base_url.startswith("https://")
    ):
        raise ValueError("task.llm.base_url must be an http(s) URL")
    return route


def _refuse_when_cancelled(run: _Run) -> Callable[[], None]:
    """Build the delivery-point check for one run's prompt."""

    def check() -> None:
        if run.cancel_requested:
            raise _RunCancelled

    return check


class HarnessService:
    """Drives the harness over HTTP for an external evaluator.

    One harness instance is kept alive per model route: starting it is the
    expensive part, and a per-request process would pay that cost every time.
    Runs are isolated by session id and by their own working directory.

    A run may name the route it wants (``model``, ``base_url``, ``api_key``),
    so one long-lived service serves several models without a restart. A run
    that names none uses the deployment's own route and shares that harness.
    """

    def __init__(
        self,
        config: DeepSeekHarnessConfig,
        *,
        harness_factory: Callable[[DeepSeekHarnessConfig], Any] | None = None,
        result_callback: Any = None,
        event_callback: Any = None,
    ) -> None:
        self._config = config
        # Where each finished event is reported. Separate from the result
        # callback on purpose: a trace service that is down must not cost the
        # caller the outcome the run actually produced.
        self._event_callback = event_callback
        # Where a finished run reports its outcome. The caller that submitted a
        # task is not holding the connection open — a task can run for hours —
        # so this callback is the only way it learns the run ended.
        self._result_callback = result_callback
        # One harness per route, keyed by what actually selects the model. Two
        # runs naming the same route share it; a different route gets its own,
        # because the model is fixed when the runtime is initialized.
        self._harnesses: dict[tuple[str, ...], Any] = {}
        self._factory = harness_factory or DeepSeekHarness
        self._runs: dict[str, _Run] = {}
        self._lock = threading.Lock()
        # Guards harness construction and its one-time start per route. Kept
        # apart from ``_lock``, which guards the run registry: holding the
        # registry lock across a spawn would block every status poll.
        self._start_lock = threading.Lock()

    def _ensure_started(self, route: dict[str, str]) -> Any:
        """Start this route's harness once, even when several runs ask together.

        Each run executes on its own worker thread, so two runs arriving
        together reach this method together. ``start()`` checks whether a
        runtime already exists and then spawns one, with no lock between the
        check and the spawn: concurrent callers each pass the check and each
        launch a runtime. The process that loses the assignment keeps running
        as an orphan, and the reader thread ends up watching a pipe whose
        writer is gone — the run then never receives its events.

        The lock makes the whole start one step. It is held across the spawn
        on purpose: the expensive part happens once, and a caller that arrives
        later simply waits for that one start instead of beginning its own.
        """
        config = self._config_for(route)
        key = _route_key(config)
        with self._start_lock:
            harness = self._harnesses.get(key)
            if harness is None:
                harness = self._factory(config)
                self._harnesses[key] = harness
            harness.start()
            return harness

    def _config_for(self, route: dict[str, str]) -> DeepSeekHarnessConfig:
        """The deployment's configuration with the run's own route applied."""
        if not route:
            return self._config
        return replace(
            self._config,
            **{
                "model": route.get("model", self._config.model),
                "base_url": route.get("base_url", self._config.base_url),
                "api_key": route.get("api_key", self._config.api_key),
                "env": {**self._config.env, **_route_env(route)},
            },
        )

    def close(self) -> None:
        """Stop every harness this service started.

        One service can now hold a harness per model route, each owning its own
        runtime subprocess. Leaving them to process exit leaks a runtime per
        route for as long as the service lives, so shutdown closes them all.
        """
        with self._start_lock:
            harnesses, self._harnesses = list(self._harnesses.values()), {}
        for harness in harnesses:
            close = getattr(harness, "close", None)
            if close is None:
                continue
            try:
                close()
            except Exception as error:  # noqa: BLE001 - one route must not block the rest
                print(f"dsh-service: closing a harness failed: {error}", flush=True)

    def start_run(self, task: dict[str, Any]) -> str:
        """Accept one task and begin executing it on a worker thread.

        The evaluator polls `/v1/runs/<id>` rather than holding a connection
        open: a task can run for hours, and an idle HTTP connection would be
        dropped long before it finished.

        ``task.session_id`` selects the session explicitly; a caller that runs
        several steps of one case reuses that id so each step continues the
        same conversation. Omission keeps one fresh session per run.

        ``task.llm.model``, ``task.llm.base_url`` and ``task.llm.api_key`` name
        the route this run needs. A run that names none uses the deployment's
        route.
        """
        instruction = task.get("instruction")
        if not isinstance(instruction, str) or not instruction:
            raise ValueError("task.instruction must be a nonempty string")
        requested_session = task.get("session_id")
        if requested_session is not None and (
            not isinstance(requested_session, str) or not requested_session
        ):
            raise ValueError("task.session_id must be a nonempty string")
        route = _route_from_task(task)
        callback_url = _callback_url_from_task(task)
        run_id = uuid.uuid4().hex
        run = _Run(
            run_id=run_id,
            task_id=str(task.get("task_id") or ""),
            instruction=instruction,
            session_id=requested_session or f"session-{run_id}",
            route=_route_key(self._config_for(route)),
            callback_url=callback_url,
            request_id=str(task.get("request_id") or ""),
            event_url=_event_url_from_task(task),
            case_id=str(task.get("case_id") or task.get("task_id") or ""),
            run_user=str(task.get("run_user") or ""),
        )
        with self._lock:
            self._runs[run_id] = run

        def execute() -> None:
            try:
                # A cancellation that arrived while this thread waited for the
                # shared harness must stop the run before it starts work. Both
                # checks run before a prompt is delivered, so a cancelled run
                # never begins executing afterwards.
                if run.cancel_requested:
                    return
                harness = self._ensure_started(route)
                if run.cancel_requested:
                    return
                deliver = {"session_id": run.session_id, "before_deliver": _refuse_when_cancelled(run)}
                if self._event_callback is not None and run.event_url:
                    # Asked for only when this deployment reports events: a
                    # harness that cannot deliver them is no reason to refuse
                    # the run.
                    deliver["on_notification"] = (
                        lambda notification: self._report_event(run, notification)
                    )
                result = harness.run(instruction, **deliver)
                completed = {
                    "final_response": result.final_response,
                    "finish_reason": result.finish_reason,
                    "session_id": result.session_id,
                    "events": result.events,
                    "notifications": [
                        {"method": n.method, "payload": n.payload}
                        for n in result.notifications
                    ],
                }
                with self._lock:
                    # Cancellation claims the outcome while this turn settles;
                    # a late completion must not overwrite it.
                    if not run.cancel_requested:
                        run.result = completed
                self._report_result(run, "succeeded")
            except _RunCancelled:
                # The cancellation landed before this prompt was written, so
                # the run's state already reports it.
                pass
            except Exception as error:
                # A cancelled run's own abort error is the expected consequence
                # of the cancellation, not a run failure to report.
                if not run.cancel_requested:
                    run.error = f"{type(error).__name__}: {error}"
                    self._report_result(run, "failed")
            finally:
                # While a cancellation is in flight, only its own path publishes
                # the terminal state; otherwise the run would read as cancelled
                # before the harness confirmed it.
                with self._lock:
                    if not run.cancel_requested:
                        run.done.set()

        threading.Thread(target=execute, name=f"run-{run_id}", daemon=True).start()
        return run_id

    def _report_event(self, run: _Run, notification: Any) -> None:
        """Report one finished event to the evaluator, without blocking the run.

        The SDK delivers notifications on the turn's own thread; a slow or
        unreachable trace service must never hold up the model loop, so a
        delivery failure is reported and dropped rather than raised into it.
        """
        callback = self._event_callback
        if callback is None or not run.event_url:
            return
        payload = notification.payload if isinstance(getattr(notification, "payload", None), dict) else {}
        event = payload.get("event")
        if not isinstance(event, dict):
            return
        run.reported += 1
        body = {
            "evaluation_id": run.request_id or run.run_id,
            "case_id": run.case_id,
            "source_session_id": str(payload.get("sessionId") or run.session_id),
            "seq": run.reported,
            "first_seq": 1,
            "final": False,
            "question": run.instruction,
            "run_user": run.run_user,
            "event": event,
        }
        try:
            callback.post(
                run.event_url, body,
                timeout=float(os.environ.get("DSH_EVENT_TIMEOUT_SEC", "5")),
            )
        except Exception as error:  # noqa: BLE001 - the run must keep going
            print(f"[dsh-service] event report failed for {run.run_id}: {error}", flush=True)

    def _report_result(self, run: _Run, status: str) -> None:
        """Tell the submitting caller how this run ended.

        A callback that cannot be delivered leaves the outcome in this
        service's own record: the run is complete either way, and losing the
        notification must not lose what it computed.
        """
        callback = self._result_callback
        url = run.callback_url
        if callback is None or not url:
            return
        payload = {
            "run_id": run.run_id,
            "request_id": run.request_id,
            "status": status,
            "session_id": run.session_id,
            "task_id": run.task_id,
            "result": run.result,
            "error": run.error,
        }
        try:
            callback.post(url, payload, timeout=float(os.environ.get("DSH_CALLBACK_TIMEOUT_SEC", "10")))
        except Exception as error:  # noqa: BLE001 - the run already ended
            print(f"[dsh-service] result callback failed for {run.run_id}: {error}", flush=True)

    def run_state(self, run_id: str) -> dict[str, Any] | None:
        with self._lock:
            run = self._runs.get(run_id)
        if run is None:
            return None
        # Reported before the done flag on purpose: a cancellation still waiting
        # for the harness to settle must not read as cancelled.
        if run.cancel_state == "cancelling":
            return {"run_id": run.run_id, "status": "cancelling"}
        if not run.done.is_set():
            return {"run_id": run.run_id, "status": "running"}
        if run.cancel_state == "cancelled":
            return {"run_id": run.run_id, "status": "cancelled"}
        if run.error is not None:
            return {"run_id": run.run_id, "status": "failed", "error": run.error}
        return {"run_id": run.run_id, "status": "completed", **(run.result or {})}

    def cancel(self, run_id: str) -> bool:
        """Cancel one run's session and wait until the harness confirms it stopped.

        Only that run's session is stopped: the shared harness and every other
        run's session keep running. The run is published as ``cancelled`` only
        after the harness confirmed the session settled. A run that already
        finished keeps its recorded outcome. When the harness refuses or fails
        the cancellation, the run is published as ``failed`` with that error
        and the failure is raised, so no caller reads a false success.

        Raises:
            RuntimeError: The harness could not confirm the cancellation.
        """
        with self._lock:
            run = self._runs.get(run_id)
            if run is None:
                return False
            if run.done.is_set():
                # Nothing is executing, so there is no work to stop. The stored
                # outcome already says whether the run completed or failed.
                return True
            # Claim the intent under the same lock the worker uses to publish
            # its result, so a completion settling now is withheld or already
            # recorded. The state stays ``cancelling`` until the harness
            # confirms, and only then becomes ``cancelled``.
            run.cancel_state = "cancelling"
        # Read the harness under the start lock: a start in progress holds it,
        # so this either sees no harness (nothing launched yet) or a fully
        # initialized one. The instance must be the one this run was bound to:
        # with several routes alive, cancelling through another route's harness
        # would leave the run's own session working. Cancelling calls start()
        # itself otherwise, which would race the worker's handshake.
        with self._start_lock:
            harness = self._harnesses.get(run.route)
        if harness is None:
            # The worker has not launched the shared harness yet; its executor
            # re-checks the intent before it delivers any prompt, so no
            # cancellation request can reach a session that does not exist.
            with self._lock:
                run.cancel_state = "cancelled"
                run.done.set()
            return True
        try:
            harness.cancel_session(run.session_id)
        except Exception as error:
            with self._lock:
                run.cancel_state = "cancel-failed"
                run.error = f"cancellation failed: {type(error).__name__}: {error}"
                run.done.set()
            raise RuntimeError(run.error) from error
        with self._lock:
            run.cancel_state = "cancelled"
            run.done.set()
        return True


def config_from_environment() -> DeepSeekHarnessConfig:
    """Read the harness configuration this deployment launched with.

    The values are required: a service that starts without a model route would
    accept work and fail every task, which is harder to diagnose than refusing
    to start.
    """

    def required(name: str) -> str:
        value = os.environ.get(name, "").strip()
        if not value:
            raise RuntimeError(f"dsh service requires {name} in the environment")
        return value

    def optional(name: str) -> str | None:
        value = os.environ.get(name, "").strip()
        return value or None

    raw_patches = os.environ.get("DSH_PATCHES", "")
    patches = tuple(p.strip() for p in raw_patches.split(":") if p.strip())
    request_budget = float(os.environ.get("DSH_REQUEST_TIMEOUT_SECONDS", "30"))
    if not math.isfinite(request_budget) or request_budget <= 0:
        raise ValueError("DSH_REQUEST_TIMEOUT_SECONDS must be finite and positive")
    return DeepSeekHarnessConfig(
        provider=required("LLM_PROVIDER"),
        model=required("LLM_MODEL"),
        dsh_bin=optional("DSH_BIN"),
        profile=optional("DSH_PROFILE") or "sdk",
        patches=patches,
        dsh_home=optional("DSH_HOME"),
        base_url=required("LLM_BASE_URL"),
        api_key=required("LLM_API_KEY"),
        initialize_timeout_seconds=float(os.environ.get("DSH_INITIALIZE_TIMEOUT", "300")),
        request_timeout_seconds=request_budget,
    )


def _handler(service: HarnessService) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, format: str, *args: Any) -> None:
            print(f"dsh-service: {format % args}", flush=True)

        def _reply(self, status: int, body: dict[str, Any]) -> None:
            payload = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def _body(self) -> dict[str, Any]:
            length = int(self.headers.get("content-length") or 0)
            if length <= 0:
                return {}
            parsed = json.loads(self.rfile.read(length))
            if not isinstance(parsed, dict):
                raise ValueError("request body must be a JSON object")
            return parsed

        def do_GET(self) -> None:  # noqa: N802 - name fixed by BaseHTTPRequestHandler
            if self.path == "/healthz":
                self._reply(200, {"status": "ok"})
                return
            if self.path.startswith("/v1/runs/"):
                run_id = self.path.rsplit("/", 1)[-1]
                state = service.run_state(run_id)
                if state is None:
                    self._reply(404, {"error": {"message": "run not found"}})
                    return
                self._reply(200, state)
                return
            self._reply(404, {"error": {"message": f"no route for {self.path}"}})

        def do_POST(self) -> None:  # noqa: N802 - name fixed by BaseHTTPRequestHandler
            try:
                if self.path == "/v1/runs":
                    body = self._body()
                    task = body.get("task")
                    if not isinstance(task, dict):
                        raise ValueError("missing task object")
                    run_id = service.start_run(task)
                    self._reply(200, {"run_id": run_id})
                    return
                if self.path.startswith("/v1/runs/") and self.path.endswith("/cancel"):
                    run_id = self.path.split("/")[3]
                    if not service.cancel(run_id):
                        self._reply(404, {"error": {"message": "run not found"}})
                        return
                    state = service.run_state(run_id)
                    self._reply(200, {"run_id": run_id, "status": state["status"]})
                    return
                self._reply(404, {"error": {"message": f"no route for {self.path}"}})
            except ValueError as error:
                self._reply(400, {"error": {"message": str(error)}})
            except json.JSONDecodeError as error:
                self._reply(400, {"error": {"message": f"invalid JSON: {error}"}})
            except RuntimeError as error:
                # A cancellation the harness could not confirm is a failed
                # request, never a success response.
                self._reply(500, {"error": {"message": str(error)}})

    return Handler


def serve(host: str, port: int) -> None:
    """Run the harness service until the process is stopped."""
    service = HarnessService(config_from_environment())
    server = ThreadingHTTPServer((host, port), _handler(service))
    print(f"dsh-service: listening on {host}:{port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        service.close()


def main() -> int:
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8080)
    args = parser.parse_args()
    serve(args.host, args.port)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
