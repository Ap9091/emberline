"""
"Ask Emberline" - the guide built into the app (same behaviour as the Vercel function app/assistant/chat_vercel.js).

POST /api/chat  {messages: [{role, content}], screen: {...}}  ->  {reply, actions, suggestions}
Needs ANTHROPIC_API_KEY in .env (Claude Sonnet 5.5 by default, EMBERLINE_ASSISTANT_MODEL to change it).
Without a key the endpoint answers 503 {offline: true} and the browser falls back to its built-in answers.
"""

import json
import os

from .paths import ROOT

MODEL = os.getenv("EMBERLINE_ASSISTANT_MODEL", "claude-sonnet-5-5")
MAX_TURNS, MAX_CHARS = 12, 600

with open(os.path.join(ROOT, "app", "assistant", "knowledge.md"), encoding="utf-8") as f:
    KNOWLEDGE = f.read()

_ACTION = {
    "type": "object", "additionalProperties": False,
    "required": ["type", "target", "hour", "from_deg", "speed_kmh"],
    "properties": {
        "type": {"type": "string", "enum": ["mode", "fire", "hour", "show", "wind", "real_wind", "town", "copilot", "demo"]},
        "target": {"type": "string"}, "hour": {"type": "integer"},
        "from_deg": {"type": "integer"}, "speed_kmh": {"type": "integer"},
    },
}
SCHEMA = {
    "type": "object", "additionalProperties": False, "required": ["reply", "actions", "suggestions"],
    "properties": {"reply": {"type": "string"}, "actions": {"type": "array", "items": _ACTION},
                   "suggestions": {"type": "array", "items": {"type": "string"}}},
}


class Offline(Exception):
    pass


def available():
    return bool(os.getenv("ANTHROPIC_API_KEY", "").strip())


def _clean(raw):
    msgs = [{"role": m["role"], "content": m["content"][: MAX_CHARS if m["role"] == "user" else 2000]}
            for m in (raw or []) if isinstance(m, dict) and m.get("role") in ("user", "assistant")
            and isinstance(m.get("content"), str) and m["content"].strip()][-MAX_TURNS:]
    while msgs and msgs[0]["role"] != "user":
        msgs.pop(0)
    return msgs if msgs and msgs[-1]["role"] == "user" else None


def _loose(text):
    for chunk in (text, text[text.find("{"): text.rfind("}") + 1]):
        try:
            return json.loads(chunk)
        except (ValueError, TypeError):
            pass
    return {"reply": text.strip(), "actions": [], "suggestions": []}


def chat(raw_messages, screen):
    if not available():
        raise Offline("no ANTHROPIC_API_KEY")
    msgs = _clean(raw_messages)
    if not msgs:
        raise ValueError("no question")
    import anthropic
    client = anthropic.Anthropic(max_retries=1, timeout=25)
    msgs[-1] = {"role": "user", "content": msgs[-1]["content"] + "\n\n<screen>" + json.dumps(screen or {})[:4000] + "</screen>"}
    base = dict(model=MODEL, max_tokens=1000, messages=msgs,
                system=[{"type": "text", "text": KNOWLEDGE, "cache_control": {"type": "ephemeral"}}])
    try:
        # structured JSON answer, low effort (chat), server-side fallback model if Sonnet declines
        res = client.beta.messages.create(**base, betas=["server-side-fallback-2026-07-01"], fallbacks="default",
                                          output_config={"effort": "low", "format": {"type": "json_schema", "schema": SCHEMA}})
    except anthropic.BadRequestError:
        res = client.messages.create(**base)      # an option was not accepted: ask plainly (the prompt asks for JSON)
    except (anthropic.APIConnectionError, anthropic.AuthenticationError, anthropic.PermissionDeniedError) as e:
        raise Offline(str(e)[:200])
    if res.stop_reason == "refusal":
        return {"reply": "I can't help with that one. Ask me about the fires, the forecast or the results.",
                "actions": [], "suggestions": ["How accurate is it?", "What am I looking at?"]}
    out = _loose("".join(b.text for b in res.content if getattr(b, "type", "") == "text"))
    return {"reply": str(out.get("reply", ""))[:1200],
            "actions": out.get("actions", [])[:6] if isinstance(out.get("actions"), list) else [],
            "suggestions": [str(s)[:60] for s in out.get("suggestions", [])[:3]] if isinstance(out.get("suggestions"), list) else []}
