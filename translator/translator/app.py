"""Language Translation Tool - Flask backend.

Provider order: Google Cloud Translation (if GOOGLE_API_KEY is set) -> MyMemory (free, no key).
"""
import html, os, re, time
from collections import defaultdict, deque
from functools import lru_cache

import requests
from dotenv import load_dotenv
from flask import Flask, jsonify, request

load_dotenv()
app = Flask(__name__, static_folder="static", static_url_path="")

GOOGLE_KEY = os.getenv("GOOGLE_API_KEY", "").strip()
MM_EMAIL = os.getenv("MYMEMORY_EMAIL", "").strip()
MAX_CHARS = 5000
CHUNK = 450            # MyMemory accepts max ~500 bytes per request
TIMEOUT = 10
RATE_LIMIT, RATE_WINDOW = 30, 60   # 30 requests / minute / IP

LANGUAGES = {
    "en": "English", "hi": "Hindi", "bn": "Bengali", "ta": "Tamil", "te": "Telugu",
    "mr": "Marathi", "gu": "Gujarati", "pa": "Punjabi", "ur": "Urdu", "es": "Spanish",
    "fr": "French", "de": "German", "it": "Italian", "pt": "Portuguese", "ru": "Russian",
    "ar": "Arabic", "zh": "Chinese (Simplified)", "ja": "Japanese", "ko": "Korean",
    "tr": "Turkish", "nl": "Dutch", "id": "Indonesian", "th": "Thai", "vi": "Vietnamese",
}
MM_CODES = {"zh": "zh-CN"}  # MyMemory needs region code for Chinese


class TranslateError(Exception):
    def __init__(self, message, status=502):
        super().__init__(message)
        self.message, self.status = message, status


# ---------- helpers ----------
def split_text(text, size=CHUNK):
    """Split on newlines, then sentences, then hard-cut, keeping every chunk <= size chars."""
    chunks = []
    for line in text.split("\n"):
        if not line.strip():
            chunks.append(line)
            continue
        buf = ""
        for s in re.split(r"(?<=[.!?।。！？])\s+", line):
            while len(s) > size:                      # very long sentence: hard cut at a space
                cut = s.rfind(" ", 0, size) or size
                cut = cut if cut > 0 else size
                if buf: chunks.append(buf); buf = ""
                chunks.append(s[:cut]); s = s[cut:].lstrip()
            if len(buf) + len(s) + 1 > size and buf:
                chunks.append(buf); buf = s
            else:
                buf = f"{buf} {s}".strip()
        if buf: chunks.append(buf)
    return chunks


def _google(text, src, tgt):
    data = {"q": text, "target": tgt, "format": "text", "key": GOOGLE_KEY}
    if src != "auto": data["source"] = src
    r = requests.post("https://translation.googleapis.com/language/translate/v2", data=data, timeout=TIMEOUT)
    if r.status_code == 429: raise TranslateError("Translation quota exceeded. Try again later.", 429)
    if r.status_code in (400, 403): raise TranslateError("Google API key is invalid or not allowed to use Translation.", 502)
    r.raise_for_status()
    t = r.json()["data"]["translations"][0]
    return html.unescape(t["translatedText"]), t.get("detectedSourceLanguage")


def _mymemory(text, src, tgt):
    s = "Autodetect" if src == "auto" else MM_CODES.get(src, src)
    params = {"q": text, "langpair": f"{s}|{MM_CODES.get(tgt, tgt)}"}
    if MM_EMAIL: params["de"] = MM_EMAIL
    r = requests.get("https://api.mymemory.translated.net/get", params=params, timeout=TIMEOUT)
    r.raise_for_status()
    j = r.json()
    status = int(j.get("responseStatus", 200))
    out = j.get("responseData", {}).get("translatedText", "")
    if status == 429 or "MYMEMORY WARNING" in out.upper():
        raise TranslateError("Free daily translation limit reached. Try again tomorrow.", 429)
    if status != 200:
        raise TranslateError(j.get("responseDetails") or "Translation service rejected the request.", 502)
    return html.unescape(out), (j.get("responseData", {}).get("detectedLanguage") or None)


@lru_cache(maxsize=512)
def translate_cached(text, src, tgt):
    provider = _google if GOOGLE_KEY else _mymemory
    parts, detected = [], None
    for chunk in split_text(text):
        if not chunk.strip():
            parts.append(chunk); continue
        for attempt in range(2):                       # one retry for flaky network
            try:
                out, det = provider(chunk, src, tgt)
                break
            except requests.Timeout:
                if attempt: raise TranslateError("The translation service timed out. Please try again.", 504)
            except requests.RequestException:
                if attempt: raise TranslateError("Could not reach the translation service.", 502)
            time.sleep(0.4)
        detected = detected or det
        parts.append(out)
    return "\n".join(parts), detected


# ---------- simple rate limiter ----------
_hits = defaultdict(deque)
def rate_limited(ip):
    now, q = time.time(), _hits[ip]
    while q and now - q[0] > RATE_WINDOW: q.popleft()
    if len(q) >= RATE_LIMIT: return True
    q.append(now); return False


# ---------- routes ----------
@app.get("/")
def index():
    return app.send_static_file("index.html")

@app.get("/api/health")
def health():
    return jsonify(status="ok", provider="google" if GOOGLE_KEY else "mymemory")

@app.get("/api/languages")
def languages():
    return jsonify(languages=[{"code": c, "name": n} for c, n in LANGUAGES.items()])

@app.post("/api/translate")
def translate():
    if rate_limited(request.remote_addr):
        return jsonify(error="Too many requests. Please wait a minute."), 429
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return jsonify(error="Request body must be valid JSON."), 400
    text, src, tgt = body.get("text"), body.get("source", "auto"), body.get("target")
    if not isinstance(text, str) or not text.strip():
        return jsonify(error="Enter some text to translate."), 400
    text = text.replace("\r\n", "\n").strip()
    if len(text) > MAX_CHARS:
        return jsonify(error=f"Text is too long. Limit is {MAX_CHARS} characters."), 413
    if tgt not in LANGUAGES:
        return jsonify(error="Choose a valid target language."), 400
    if src != "auto" and src not in LANGUAGES:
        return jsonify(error="Choose a valid source language."), 400
    if src == tgt:
        return jsonify(translation=text, detected=None, note="Source and target are the same.")
    try:
        out, detected = translate_cached(text, src, tgt)
    except TranslateError as e:
        return jsonify(error=e.message), e.status
    except Exception:
        app.logger.exception("Unexpected error")
        return jsonify(error="Something went wrong on the server."), 500
    det = (detected or "").split("-")[0].lower() or None
    return jsonify(translation=out, detected=det if det in LANGUAGES else None)

@app.errorhandler(404)
def nf(_): return jsonify(error="Not found."), 404
@app.errorhandler(405)
def na(_): return jsonify(error="Method not allowed."), 405

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", 5000)), debug=False)
