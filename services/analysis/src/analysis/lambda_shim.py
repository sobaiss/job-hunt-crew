"""Local stand-in for the 3 deployed AnalysisWorkflow Lambda functions
(M5-T2), for exercising the real Step Functions state machine against real
handler code in dev/tests without deploying to AWS Lambda — the same role
MinIO/ElasticMQ play for S3/SQS elsewhere in this repo.

Implements the subset of the Lambda Invoke HTTP API
(`POST /2015-03-31/functions/{name}/invocations`) that Step Functions Local
speaks when configured with `LAMBDA_ENDPOINT` pointed at this server,
dispatching by the invoked ARN's function-name suffix to the real handlers
in analysis.handlers.
"""

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from .handlers import (
    ensure_cv_converted_handler,
    ensure_cv_parsed_handler,
    ensure_offer_extracted_handler,
    mark_analysis_failed_handler,
    run_comparison_crew_handler,
)

HANDLERS_BY_FUNCTION_NAME = {
    "ensure-cv-converted": ensure_cv_converted_handler,
    "ensure-cv-parsed": ensure_cv_parsed_handler,
    "ensure-offer-extracted": ensure_offer_extracted_handler,
    "run-comparison-crew": run_comparison_crew_handler,
    "mark-analysis-failed": mark_analysis_failed_handler,
}

DEFAULT_PORT = 9099


class _InvokeRequestHandler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        # Path shape: /2015-03-31/functions/<name-or-arn>/invocations
        parts = self.path.split("/")
        function_ref = parts[3] if len(parts) > 3 else ""
        function_name = function_ref.split(":")[-1]

        handler = HANDLERS_BY_FUNCTION_NAME.get(function_name)
        if handler is None:
            self._respond(404, {"errorMessage": f"Unknown function {function_name!r}"})
            return

        payload = json.loads(self._read_body() or b"{}")

        try:
            result = handler(payload)
        except Exception as exc:  # noqa: BLE001 - Lambda's contract reports handler errors as a 200 body, not a 5xx
            # Real Lambda (and Step Functions' interpretation of it) only
            # treats a 200 response as a *function error* — vs. a normal
            # successful payload that merely happens to look like one — when
            # the `X-Amz-Function-Error` header is present; without it, Step
            # Functions Local passes this error body through as if it were
            # this state's real output, so no Retry/Catch ever fires (the
            # bug M5-T5's retry-then-fail test caught: EnsureCVParsed
            # "succeeded" with an error-shaped payload as output instead of
            # failing the Task state at all).
            self._respond(
                200, {"errorMessage": str(exc), "errorType": type(exc).__name__}, function_error=True
            )
            return

        self._respond(200, result)

    def _read_body(self) -> bytes:
        # The AWS SDK (Step Functions Local's Lambda client) sends Lambda
        # Invoke requests with `Transfer-Encoding: chunked` and no
        # Content-Length header, so a plain rfile.read(Content-Length)
        # (BaseHTTPRequestHandler does no dechunking of its own) would either
        # read zero bytes or block forever.
        if "chunked" in self.headers.get("Transfer-Encoding", "").lower():
            chunks = []
            while True:
                size_line = self.rfile.readline().strip()
                size = int(size_line.split(b";")[0], 16)
                if size == 0:
                    self.rfile.readline()  # trailing CRLF after the terminating 0-size chunk
                    break
                chunks.append(self.rfile.read(size))
                self.rfile.readline()  # CRLF after each chunk's data
            return b"".join(chunks)
        content_length = int(self.headers.get("Content-Length", 0))
        return self.rfile.read(content_length)

    def _respond(self, status: int, body: dict, *, function_error: bool = False) -> None:
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        if function_error:
            self.send_header("X-Amz-Function-Error", "Unhandled")
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, format: str, *args) -> None:  # noqa: A002 - matches BaseHTTPRequestHandler's signature
        pass


def make_server(port: int = DEFAULT_PORT) -> ThreadingHTTPServer:
    return ThreadingHTTPServer(("0.0.0.0", port), _InvokeRequestHandler)


if __name__ == "__main__":
    make_server().serve_forever()
