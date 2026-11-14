"""
The AI writer. One setting picks the provider:
  * ANTHROPIC_API_KEY set  -> Claude (EMBERLINE_CLAUDE_MODEL, default claude-haiku-5-5; use claude-sonnet-5-5 for the demo)
  * otherwise              -> Gemini (GEMINI_API_KEY, EMBERLINE_GEMINI_MODEL, default gemini-3.8-flash)
Adding the Claude key later needs NO code change: just put it in .env and restart.

Every answer is cached on disk (data/ai_cache/), keyed by the exact question, so the demo runs offline.
If the AI cannot be reached and there is no cached answer, callers get AIOffline and the app shows
"AI offline, forecast only".

The AI only WRITES (plans, briefings, alerts). It never decides alone: plain code checks every plan
(safety.py) and a human approves.
"""

import hashlib
import json
import os
import re
import time

from dotenv import load_dotenv

from .paths import AI_CACHE, ROOT

load_dotenv(os.path.join(ROOT, ".env"))

CLAUDE_MODEL = os.getenv("EMBERLINE_CLAUDE_MODEL", "claude-haiku-5-5")
GEMINI_MODEL = os.getenv("EMBERLINE_GEMINI_MODEL", "gemini-3.8-flash")
# If the main Gemini model is overloaded (HTTP 503), try these next. The answer records which model replied.
GEMINI_FALLBACKS = ["gemini-3.7-flash", "gemini-3.5-flash", "gemini-2.5-flash"]
TIMEOUT_S = 60
BUSY_SKIP_S = 600     # skip an overloaded model for 10 minutes
_BUSY = {}


class AIOffline(Exception):
    pass


def provider():
    if os.getenv("ANTHROPIC_API_KEY", "").strip():
        return "claude", CLAUDE_MODEL
    if os.getenv("GEMINI_API_KEY", "").strip():
        return "gemini", GEMINI_MODEL
    return None, None


SYSTEM = (
    "You are Emberline, an AI copilot for a California wildfire incident commander or county emergency manager. "
    "You write short, calm, factual text for professionals. Use ONLY the facts and numbers in the data you are "
    "given; never invent numbers, places, roads or resources. Times are local Pacific time. "
    "A human makes every decision; you draft and recommend."
)


def _cache_path(key):
    return os.path.join(AI_CACHE, f"{key}.json")


def _call_gemini(prompt, want_json, max_tokens):
    from google import genai
    from google.genai import types
    client = genai.Client(api_key=os.environ["GEMINI_API_KEY"], http_options=types.HttpOptions(timeout=TIMEOUT_S * 1000))
    base = dict(system_instruction=SYSTEM, temperature=0.3, max_output_tokens=max(max_tokens, 4096),
                response_mime_type="application/json" if want_json else "text/plain")
    last = None
    for model in [GEMINI_MODEL] + [m for m in GEMINI_FALLBACKS if m != GEMINI_MODEL]:
        if _BUSY.get(model, 0) > time.time():
            continue                                   # this model was overloaded a few minutes ago: skip it
        for thinking in (types.ThinkingConfig(thinking_level="low"), None):   # keep "thinking" short where supported
            try:
                cfg = types.GenerateContentConfig(**base, **({"thinking_config": thinking} if thinking else {}))
                r = client.models.generate_content(model=model, contents=prompt, config=cfg)
                if r.text:
                    return r.text.strip(), model
                last = ValueError("empty reply")
                break
            except Exception as e:
                last = e
                msg = str(e)
                if "503" in msg or "UNAVAILABLE" in msg or "429" in msg or "RESOURCE_EXHAUSTED" in msg:
                    _BUSY[model] = time.time() + BUSY_SKIP_S    # overloaded / rate limited: try the next model
                    break
                # otherwise (e.g. this model does not accept thinking_level): try again without it
    raise last or RuntimeError("all Gemini models busy")


def _call_claude(prompt, want_json, max_tokens):
    import anthropic
    client = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"], timeout=TIMEOUT_S)
    if want_json:
        prompt += "\n\nReply with ONLY the JSON object, no other text."
    msg = client.messages.create(model=CLAUDE_MODEL, max_tokens=max_tokens, system=SYSTEM,
                                 messages=[{"role": "user", "content": prompt}])
    return "".join(b.text for b in msg.content if getattr(b, "type", "") == "text").strip(), CLAUDE_MODEL


def ask(task, prompt, want_json=False, max_tokens=2048):
    """Ask the AI. Returns {"text" or "json", "provider", "model", "cached", "seconds"}. Raises AIOffline."""
    prov, model = provider()
    key = hashlib.sha256(json.dumps([prov, model, task, SYSTEM, prompt, want_json]).encode()).hexdigest()[:32]
    path = _cache_path(key)
    if os.path.exists(path):
        with open(path) as f:
            out = json.load(f)
        out["cached"] = True
        return out
    if prov is None:
        raise AIOffline("no AI key configured")
    t0 = time.time()
    last = None
    for attempt in range(3):
        try:
            text, used = (_call_claude if prov == "claude" else _call_gemini)(prompt, want_json, max_tokens)
            out = {"task": task, "provider": prov, "model": used, "seconds": round(time.time() - t0, 1)}
            if want_json:
                out["json"] = parse_json(text)
            else:
                out["text"] = text
            with open(path, "w") as f:
                json.dump(out, f)
            out["cached"] = False
            return out
        except Exception as e:  # network errors, rate limits, bad JSON: retry, then give up
            last = e
            time.sleep(1.5 * (attempt + 1))
    raise AIOffline(f"{type(last).__name__}: {str(last)[:200]}")


def parse_json(text):
    """Read a JSON object out of the model's reply (tolerates ```json fences)."""
    text = text.strip()
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        raise ValueError("no JSON object in reply")
    return json.loads(m.group(0))


def status():
    prov, model = provider()
    return {"provider": prov, "model": model,
            "note": None if prov else "No AI key: AI offline, forecast only",
            "switch": "Add ANTHROPIC_API_KEY to .env and restart to use Claude (no code change)."}
