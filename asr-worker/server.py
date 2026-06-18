#!/usr/bin/env python3
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8790"))
MODEL_NAME = os.environ.get("PARAKEET_ONNX_MODEL", "nemo-parakeet-tdt-0.6b-v3")
QUANTIZATION = os.environ.get("PARAKEET_ONNX_QUANTIZATION", "int8")

model_lock = threading.Lock()


def load_model():
    try:
        import onnx_asr
    except ImportError as exc:
        print("[asr-worker] onnx-asr is not installed", file=sys.stderr)
        print("[asr-worker] install: python -m pip install -r requirements.txt", file=sys.stderr)
        raise SystemExit(1) from exc

    print(
        "[asr-worker] loading Parakeet ONNX "
        f"model={MODEL_NAME!r} quantization={QUANTIZATION!r}",
        flush=True,
    )
    loaded = onnx_asr.load_model(MODEL_NAME, quantization=QUANTIZATION)
    print("[asr-worker] ready", flush=True)
    return loaded


MODEL = load_model()


def json_response(handler, status, payload):
    body = json.dumps(payload).encode("utf-8")
    handler.send_response(status)
    handler.send_header("content-type", "application/json")
    handler.send_header("content-length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def normalize_result(result):
    if isinstance(result, dict):
        return str(result.get("text") or "").strip()
    return str(result or "").strip()


class Handler(BaseHTTPRequestHandler):
    server_version = "EvenAudioPipeASR/0.1"

    def do_GET(self):
        if self.path != "/health":
            json_response(self, 404, {"ok": False, "error": "not found"})
            return
        json_response(
            self,
            200,
            {
                "ok": True,
                "model": MODEL_NAME,
                "quantization": QUANTIZATION,
            },
        )

    def do_POST(self):
        if self.path != "/transcribe":
            json_response(self, 404, {"ok": False, "error": "not found"})
            return

        try:
            length = int(self.headers.get("content-length", "0"))
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            wav_path = Path(str(payload.get("wavPath") or payload.get("path") or ""))
            if not wav_path.is_file():
                json_response(self, 400, {"ok": False, "error": f"wav file not found: {wav_path}"})
                return

            with model_lock:
                text = normalize_result(MODEL.recognize(str(wav_path)))
            json_response(self, 200, {"ok": True, "text": text})
        except Exception as exc:
            json_response(self, 500, {"ok": False, "error": str(exc)})

    def log_message(self, fmt, *args):
        print(f"[asr-worker] {self.address_string()} {fmt % args}", file=sys.stderr)


def main():
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"[asr-worker] listening on http://{HOST}:{PORT}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
