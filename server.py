"""
Tiny local server for the chess trainer: static files, a chess.com single-game proxy,
and the "chat with Nick" endpoint (free Google Gemini key, or Claude via the Anthropic SDK).
Run:  python server.py   (then open http://localhost:8765)
"""
import hashlib
import http.server
import json
import mimetypes
import os
import re
import shutil
import socket
import socketserver
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser

try:
    import anthropic
except ImportError:  # chat is optional; everything else works without it
    anthropic = None

try:
    import edge_tts  # Microsoft's neural voices (the ones Edge reads aloud with) - free, no key
except ImportError:
    edge_tts = None

# On some networks the IPv6 addresses never connect, and Python tries each of them for the whole
# timeout before falling back to IPv4 (curl and browsers don't). Try IPv4 first.
_getaddrinfo = socket.getaddrinfo
socket.getaddrinfo = lambda *a, **k: sorted(_getaddrinfo(*a, **k), key=lambda info: info[0] != socket.AF_INET)

PORT = int(os.environ.get("PORT", "8765"))
# PUBLIC=1 when the site runs on the internet (see Dockerfile): keys come only from environment
# variables, visitors can't change them, and each visitor gets a limited number of chat questions.
PUBLIC = os.environ.get("PUBLIC") == "1"
HOST = os.environ.get("HOST", "0.0.0.0" if PUBLIC else "127.0.0.1")
CHAT_LIMIT_PER_HOUR = int(os.environ.get("CHAT_LIMIT_PER_HOUR", "30"))
ROOT = os.path.dirname(os.path.abspath(__file__))
SECRETS = os.path.join(ROOT, ".secrets.json")
ALLOWED_ORIGINS = {f"http://localhost:{PORT}", f"http://127.0.0.1:{PORT}"}
MODEL = "claude-opus-5-5"

mimetypes.add_type("application/wasm", ".wasm")
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/css", ".css")
mimetypes.add_type("image/webp", ".webp")


UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) chess-trainer"


def fetch(url):
    """GET a URL -> (body, status). chess.com's CDN stalls Python's own TLS client for
    minutes, so use the system curl when there is one."""
    curl = shutil.which("curl")
    if curl:
        try:
            out = subprocess.run(
                [curl, "-s", "-A", UA, "-H", "Accept: application/json", "--max-time", "20",
                 "-w", "\n%{http_code}", url],
                capture_output=True, timeout=25, check=False,
            ).stdout
            body, _, code = out.rpartition(b"\n")
            status = int(code or 0)
            if status:
                return (body if status == 200 else b'{"error":"not found"}'), status
        except (OSError, subprocess.SubprocessError, ValueError):
            pass
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=20) as res:
            return res.read(), res.status
    except urllib.error.HTTPError as e:
        return b'{"error":"not found"}', e.code
    except Exception:
        return b'{"error":"network"}', 502


# ---------------- chat with Nick ----------------

NICK_PROMPT = """You are Nick (ניק), the coach character of a Hebrew chess-training website. Nick is a goofy dog \
with big human ears and human hands, and he is genuinely a strong, practical chess coach.

How to answer:
- Always answer in Hebrew. Casual and warm, with light dog humor now and then (an occasional "הב!"), but the \
substance must be real, accurate chess advice.
- Keep it short: usually 3-8 sentences or a short list. Answers may be read aloud by text-to-speech, so use plain \
sentences and simple "- " bullet lists only - no tables, no headings.
- Write chess moves in standard algebraic notation (Nf3, O-O, exd5).
- If a player profile is given below, tailor the advice to it: their rating, their biggest weaknesses, their openings.
- When it fits, point the player to the site's own tools: the "אימון" tab (fix your own mistakes, flip the board, \
the safe-or-blunder drill, blunder-check mode), "חידות מובחרות" (top-rated Lichess puzzles, long calculation \
puzzles), "מנתח משחקים" (move-by-move review of any game), and "פתיחות" (London System, English Opening, \
Italian Game, Caro-Kann).
- If you are not sure about a concrete opening line, or about a position you cannot see, say so instead of \
inventing moves.
- Nick has a strange, funny obsession with mayonnaise and sausages (נקניקיות). Slip it into roughly every second answer as a short, original dog joke or comparison - e.g. "I love this move like I love sausages" - but invent new ones, never repeat the same joke, and never let it get in the way of the actual advice.
- Stay on chess and getting better at chess; if asked about something else, steer back to chess in a friendly way."""


def load_secrets():
    if PUBLIC:
        return {}
    try:
        with open(SECRETS, encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def saved_key():
    return load_secrets().get("anthropic_api_key") or None


def gemini_key():
    key = load_secrets().get("gemini_api_key") or os.environ.get("GEMINI_API_KEY") or ""
    return key.strip().strip('"').strip("'") or None  # pasted keys often carry spaces/quotes


def claude_available():
    return anthropic is not None and bool(
        saved_key() or os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"))


def chat_status():
    # Pollinations needs no key at all, so the chat always works; a Gemini/Claude key gives better answers
    providers = {"gemini": bool(gemini_key()), "claude": claude_available(), "pollinations": True}
    chosen = load_secrets().get("provider")
    if not providers.get(chosen):
        chosen = "gemini" if providers["gemini"] else "claude" if providers["claude"] else "pollinations"
    if chosen:
        return {"ready": True, "provider": chosen, "providers": providers, "public": PUBLIC}
    return {"ready": False, "reason": "key", "providers": providers, "public": PUBLIC}


_chat_hits = {}
_chat_lock = threading.Lock()


def chat_allowed(ip):
    """At most CHAT_LIMIT_PER_HOUR questions per visitor per hour on a public site."""
    if not PUBLIC:
        return True
    now = time.time()
    with _chat_lock:
        hits = [t for t in _chat_hits.get(ip, []) if now - t < 3600]
        if len(hits) >= CHAT_LIMIT_PER_HOUR:
            _chat_hits[ip] = hits
            return False
        hits.append(now)
        _chat_hits[ip] = hits
        return True


# Free tier: the "latest Flash" alias follows Google's newest free Flash model; the rest are fallbacks.
GEMINI_MODELS = ["gemini-flash-latest", "gemini-flash-lite-latest", "gemini-flash-latest"]


def pollinations_stream(system, messages, write):
    """Free, no key (pollinations.ai, OpenAI-compatible). Errors become [[ERR:...]] markers."""
    body = json.dumps({"model": "openai", "stream": True,
                       "messages": [{"role": "system", "content": system}] + messages}).encode("utf-8")
    req = urllib.request.Request("https://text.pollinations.ai/openai", data=body, method="POST",
                                 headers={"Content-Type": "application/json", "User-Agent": UA})
    wrote = False
    try:
        with urllib.request.urlopen(req, timeout=120) as res:
            for raw in res:
                line = raw.decode("utf-8", "ignore").strip()
                if not line.startswith("data:") or line == "data: [DONE]":
                    continue
                try:
                    chunk = json.loads(line[5:])
                except ValueError:
                    continue
                for choice in chunk.get("choices", []):
                    text = (choice.get("delta") or {}).get("content")
                    if text:
                        write(text)
                        wrote = True
        if not wrote:
            write("[[ERR:api:500]]")
    except urllib.error.HTTPError as e:
        write("[[ERR:rate]]" if e.code in (402, 429) else f"[[ERR:api:{e.code}]]")
    except (urllib.error.URLError, TimeoutError, OSError):
        write("[[ERR:cut]]" if wrote else "[[ERR:net]]")


def gemini_diag():
    """What Google says about the configured key (never returns the key itself)."""
    key = gemini_key()
    if not key:
        return {"key": "missing"}
    info = {"key": f"{len(key)} chars, starts with {key[:3]}", "spaces": key != key.strip()}
    body = json.dumps({"contents": [{"role": "user", "parts": [{"text": "hi"}]}]}).encode()
    req = urllib.request.Request(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent",
        data=body, method="POST", headers={"Content-Type": "application/json", "x-goog-api-key": key.strip()})
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            info["google"] = f"ok {res.status}"
    except urllib.error.HTTPError as e:
        err = json.loads(e.read() or b"{}").get("error", {})
        info["google"] = f"{e.code} {err.get('status')}: {str(err.get('message'))[:200]}"
    except Exception as e:
        info["google"] = f"network: {type(e).__name__}"
    return info


def gemini_stream(key, system, messages, write):
    """Stream a Gemini answer through `write`; errors become [[ERR:...]] markers."""
    body = json.dumps({
        "systemInstruction": {"parts": [{"text": system}]},
        "contents": [{"role": "model" if m["role"] == "assistant" else "user", "parts": [{"text": m["content"]}]}
                     for m in messages],
        "generationConfig": {"maxOutputTokens": 8192},
    }).encode("utf-8")
    last = 404
    wrote = False
    for model in GEMINI_MODELS:
        req = urllib.request.Request(
            f"https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse",
            data=body, method="POST",
            headers={"Content-Type": "application/json", "x-goog-api-key": key})
        try:
            with urllib.request.urlopen(req, timeout=90) as res:
                wrote = False
                finish = None
                for raw in res:
                    line = raw.decode("utf-8", "ignore").strip()
                    if not line.startswith("data:"):
                        continue
                    chunk = json.loads(line[5:])
                    for cand in chunk.get("candidates", []):
                        finish = cand.get("finishReason") or finish
                        for part in cand.get("content", {}).get("parts", []):
                            if part.get("text") and not part.get("thought"):
                                write(part["text"])
                                wrote = True
                    if chunk.get("promptFeedback", {}).get("blockReason"):
                        return write("[[ERR:refusal]]")
                if not wrote:
                    write("[[ERR:refusal]]")
                elif finish not in ("STOP", "MAX_TOKENS"):
                    write("[[ERR:cut]]")  # the answer stopped in the middle
                return
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "ignore")
            if e.code == 404:
                continue  # model name not available on this key: try the next one
            if e.code in (500, 502, 503, 504):
                last = e.code
                time.sleep(1.5)  # Google's free tier is often briefly overloaded: retry on the next model
                continue
            if "API_KEY_INVALID" in detail or "API key not valid" in detail or e.code in (401, 403):
                return write("[[ERR:auth]]")
            if e.code == 429:
                return write("[[ERR:rate]]")
            return write(f"[[ERR:api:{e.code}]]")
        except (urllib.error.URLError, TimeoutError, OSError, ValueError):
            return write("[[ERR:cut]]" if wrote else "[[ERR:net]]")
    write(f"[[ERR:api:{last}]]")


def clean_messages(raw):
    msgs = []
    for m in (raw or [])[-24:]:
        role = m.get("role") if isinstance(m, dict) else None
        text = str(m.get("content") or "")[:6000] if role in ("user", "assistant") else ""
        if text.strip():
            msgs.append({"role": role, "content": text})
    while msgs and msgs[0]["role"] != "user":
        msgs.pop(0)
    return msgs


# ---------------- Nick's voice ----------------

TTS_VOICES = {"he-IL-AvriNeural", "he-IL-HilaNeural"}
TTS_CACHE = os.path.join(ROOT, ".tts-cache")
RATE = re.compile(r"^[+-]\d{1,2}%$")
PITCH = re.compile(r"^[+-]\d{1,2}Hz$")


def tts_cache_trim():
    files = sorted((os.path.join(TTS_CACHE, f) for f in os.listdir(TTS_CACHE)), key=os.path.getmtime)
    for f in files[:-2000]:
        try:
            os.remove(f)
        except OSError:
            pass


GAME_PATH = re.compile(r"^/api/chesscom-game\?type=(live|daily)&id=(\d{1,15})$")


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def do_GET(self):
        if self.path == "/api/chat/status":
            return self.send_json(200, chat_status())
        if self.path == "/api/chat/diag":
            return self.send_json(200, gemini_diag())
        if self.path == "/api/tts/status":
            return self.send_json(200, {"ok": edge_tts is not None, "voices": sorted(TTS_VOICES)})
        if self.path.startswith("/api/tts?"):
            return self.tts()
        if self.path.startswith("/api/"):
            return self.chesscom_game()
        # never serve dotfiles (the saved API key lives in one)
        if any(part.startswith(".") for part in self.path.split("?")[0].split("/") if part):
            return self.send_error(404)
        return super().do_GET()

    def origin_ok(self):
        """Only pages served by this server may POST (blocks other sites in the browser)."""
        origin = self.headers.get("Origin") or ""
        if origin in ALLOWED_ORIGINS:
            return True
        host = urllib.parse.urlsplit(origin).netloc
        return PUBLIC and bool(host) and host in (self.headers.get("Host"), self.headers.get("X-Forwarded-Host"))

    def client_ip(self):
        fwd = self.headers.get("X-Forwarded-For")
        return fwd.split(",")[0].strip() if fwd else self.client_address[0]

    def do_POST(self):
        if not self.origin_ok():
            return self.send_error(403)
        try:
            length = min(int(self.headers.get("Content-Length") or 0), 400_000)
            body = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            return self.send_error(400)
        if self.path == "/api/chat/key":
            return self.save_key(body)
        if self.path == "/api/chat":
            return self.chat(body)
        return self.send_error(404)

    def send_json(self, status, data):
        raw = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def save_key(self, body):
        if PUBLIC:
            return self.send_json(403, {"error": "public"})
        data = load_secrets()
        if body.get("provider") in ("gemini", "claude", "pollinations") and not body.get("key"):
            data["provider"] = body["provider"]  # just switch between saved keys
        else:
            key = str(body.get("key") or "").strip()
            if re.fullmatch(r"sk-ant-[A-Za-z0-9_\-]{20,300}", key):
                data["anthropic_api_key"], data["provider"] = key, "claude"
            elif re.fullmatch(r"[A-Za-z0-9_\-.]{30,120}", key):
                data["gemini_api_key"], data["provider"] = key, "gemini"
            else:
                return self.send_json(400, {"error": "format"})
        with open(SECRETS, "w", encoding="utf-8") as f:
            json.dump(data, f)
        return self.send_json(200, chat_status())

    def chat(self, body):
        status = chat_status()
        if not status["ready"]:
            return self.send_json(400, {"error": status["reason"]})
        messages = clean_messages(body.get("messages"))
        if not messages:
            return self.send_json(400, {"error": "empty"})
        if not chat_allowed(self.client_ip()):
            return self.send_json(429, {"error": "limit"})
        system = NICK_PROMPT
        context = str(body.get("context") or "").strip()[:5000]
        if context:
            system += "\n\n<player_profile>\n" + context + "\n</player_profile>"
        # stream plain text back; errors are appended as a [[ERR:...]] marker the page understands
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.end_headers()

        def write(text):
            self.wfile.write(text.encode("utf-8"))
            self.wfile.flush()

        if status["provider"] in ("gemini", "pollinations"):
            try:
                if status["provider"] == "gemini":
                    # a bad key / used-up quota before any text: answer through Pollinations instead
                    sent = []
                    failed = []

                    def gwrite(text):
                        if not sent and text.startswith("[[ERR:") and "cut" not in text:
                            failed.append(text)
                            return
                        sent.append(text)
                        write(text)

                    gemini_stream(gemini_key(), system, messages, gwrite)
                    if failed:
                        pollinations_stream(system, messages, write)
                else:
                    pollinations_stream(system, messages, write)
            except (BrokenPipeError, ConnectionResetError):
                pass
            return

        key = saved_key()
        client = anthropic.Anthropic(api_key=key) if key else anthropic.Anthropic()
        try:
            with client.beta.messages.stream(
                model=MODEL,
                max_tokens=16000,
                betas=["server-side-fallback-2026-07-01"],
                fallbacks="default",  # a declined request is retried on Anthropic's recommended model
                output_config={"effort": "low"},  # chat: quick answers
                system=system,
                messages=messages,
            ) as stream:
                for text in stream.text_stream:
                    write(text)
                final = stream.get_final_message()
            if final.stop_reason == "refusal":
                write("[[ERR:refusal]]")
        except anthropic.AuthenticationError:
            write("[[ERR:auth]]")
        except anthropic.PermissionDeniedError:
            write("[[ERR:auth]]")
        except anthropic.RateLimitError:
            write("[[ERR:rate]]")
        except anthropic.BadRequestError as e:
            write("[[ERR:billing]]" if "credit balance" in str(e.message).lower() else f"[[ERR:api:{e.status_code}]]")
        except anthropic.APIStatusError as e:
            write(f"[[ERR:api:{e.status_code}]]")
        except anthropic.APIConnectionError:
            write("[[ERR:net]]")
        except (BrokenPipeError, ConnectionResetError):
            pass
        except anthropic.AnthropicError:
            write("[[ERR:auth]]")

    # Speech as MP3, streamed while it is generated; every sentence is cached on disk
    def tts(self):
        q = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
        text = (q.get("t") or [""])[0].strip()[:1500]
        voice = (q.get("v") or ["he-IL-AvriNeural"])[0]
        rate = (q.get("r") or ["+0%"])[0]
        pitch = (q.get("p") or ["+0Hz"])[0]
        if edge_tts is None:
            return self.send_error(503)
        if not text or voice not in TTS_VOICES or not RATE.match(rate) or not PITCH.match(pitch):
            return self.send_error(400)
        path = os.path.join(TTS_CACHE, hashlib.sha1(f"{voice}|{rate}|{pitch}|{text}".encode()).hexdigest() + ".mp3")
        if os.path.exists(path):
            with open(path, "rb") as f:
                data = f.read()
            self.send_response(200)
            self.send_header("Content-Type", "audio/mpeg")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        audio = bytearray()
        try:
            for chunk in edge_tts.Communicate(text, voice=voice, rate=rate, pitch=pitch).stream_sync():
                if chunk.get("type") != "audio":
                    continue
                if not audio:
                    self.send_response(200)
                    self.send_header("Content-Type", "audio/mpeg")
                    self.end_headers()
                audio += chunk["data"]
                self.wfile.write(chunk["data"])
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            return
        except Exception:
            if not audio:
                return self.send_error(502)
            return
        if not audio:
            return self.send_error(502)
        try:
            os.makedirs(TTS_CACHE, exist_ok=True)
            tmp = path + ".tmp"
            with open(tmp, "wb") as f:
                f.write(audio)
            os.replace(tmp, path)
            tts_cache_trim()
        except OSError:
            pass

    # chess.com has no public single-game endpoint with CORS, so the browser asks us
    def chesscom_game(self):
        m = GAME_PATH.match(self.path)
        if not m:
            return self.send_error(400)
        url = f"https://www.chess.com/callback/{m.group(1)}/game/{m.group(2)}"
        body, status = fetch(url)
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        # the engine binary is big and never changes; everything else stays fresh
        if self.path.startswith("/engine/") or self.path.startswith("/api/tts?"):
            self.send_header("Cache-Control", "public, max-age=604800")
        else:
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    url = f"http://localhost:{PORT}"
    with Server((HOST, PORT), Handler) as httpd:
        print(f"Chess trainer running at {url}  (Ctrl+C to stop)")
        if anthropic is None:
            print("Chat with Nick is off: run  python -m pip install anthropic")
        if edge_tts is None:
            print("Nick's natural voice is off: run  python -m pip install edge-tts")
        if PUBLIC:
            print("Public mode: keys from GEMINI_API_KEY / ANTHROPIC_API_KEY, chat limited per visitor")
        elif "--no-browser" not in sys.argv:
            threading.Timer(0.8, lambda: webbrowser.open(url)).start()
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
