"""
The copilot steps that use the AI, and the plain-code SAFETY CHECK that guards them.

  briefing(sit)       -> short situation briefing, only from the model's numbers
  plan(sit)           -> AI evacuation plan; checked by safety_check(); if REJECTED the reason is sent back and the
                         AI tries again (up to 2 retries); if it still fails -> "Manual decision required"
  alert(sit, plan)    -> after a human APPROVES: draft text for the county's Wireless Emergency Alert, under 360
                         characters, labelled "Draft for county alert system, not sent"
  triage_line(inc)    -> one line on why a live incident ranks where it does
"""

import json

from . import ai
from .situation import ai_context

MAX_RETRIES = 2
ALERT_MAX = 360
NO_CLEAR_EXIT = "No clear highway exit - human decision"


def briefing(sit):
    ctx = ai_context(sit)
    prompt = ("Write the situation briefing for the incident commander: 4-6 short lines, each starting with '- '. "
              "Cover: fire size and growth, wind and humidity, which towns are EVACUATE / WARNING (with time to "
              "fire and residents), and one line on forecast limits (satellite pixels are 2-4 km; smoke and night "
              "can hide fire). Use only these facts:\n" + json.dumps(ctx, default=str))
    return ai.ask("briefing", prompt)


def _plan_prompt(ctx, feedback):
    rules = (
        "Recommend an evacuation plan as JSON with exactly these keys:\n"
        '{"evacuate": [{"town": "<name>", "exit": "<exit id copied exactly from that town\'s exits list>", '
        '"reason": "<max 15 words>"}], "warn": ["<town>", ...], "summary": "<one sentence for the commander>"}\n'
        "Rules: every EVACUATE town must be in 'evacuate'. WARNING towns go in 'warn' (or 'evacuate' if you judge it "
        "necessary). For each evacuated town choose ONE exit from ITS exits list, copying the id exactly. Prefer exits "
        "that lead AWAY from the fire (towns list 'bearing_from_fire' = direction from the fire to the town, so an exit "
        "in that same direction leads away) and not downwind. If a town has no exits listed, use \"local roads\".")
    prompt = rules + "\n\nSituation:\n" + json.dumps(ctx, default=str)
    if feedback:
        prompt += ("\n\nYOUR PREVIOUS PLAN WAS REJECTED by the safety check for these reasons:\n- " +
                   "\n- ".join(feedback) + "\nFix every reason and return a corrected plan.")
    return prompt


def safety_check(plan, sit):
    """
    Plain code, no AI. A plan is REJECTED if:
      1. a town with fire at it or forecast within 1 h (EVACUATE) is not being evacuated, or
      2. an evacuation route runs through the fire now or the +1 h forecast fire (beyond the town itself), or
      3. it names a town or exit that does not exist.
    If EVERY highway exit of a town runs into the fire, no choice can pass, so that is not a rejection: the town
    is listed in `human` ("no clear highway exit: human decision needed") and the rest of the plan is checked.
    Returns (reasons, human). No reasons = ACCEPTED.
    """
    reasons, human = [], []
    towns = {t["name"]: t for t in sit["towns"]}
    evac = plan.get("evacuate") or []
    if not isinstance(evac, list):
        return ["'evacuate' must be a list"], human
    names = [e.get("town") for e in evac if isinstance(e, dict)]
    for t in sit["towns"]:
        if t["status"] == "EVACUATE" and t["name"] not in names:
            when = "is already at the town" if t["eta_h"] == 0 else "is forecast within 1 hour"
            reasons.append(f"{t['name']} ({t['population']:,} residents): fire {when}, but the plan does not evacuate it.")
    for e in evac:
        if not isinstance(e, dict):
            reasons.append("each evacuation entry must be an object with town and exit")
            continue
        town, exit_id = e.get("town"), (e.get("exit") or "").strip()
        if town not in towns:
            reasons.append(f"'{town}' is not a town in this situation.")
            continue
        options = {o["id"].lower(): o for o in sit["exits"].get(town, [])}
        if not options:
            continue                      # no highway near this town: local roads, nothing to check
        clear = [x["id"] for x in options.values() if x["blocked_1h_at_km"] is None]
        if not clear:
            human.append(f"{town}: every highway exit runs into the fire or the +1 h forecast fire. "
                         "No clear route: human decision needed (escort, shelter in place, or local roads).")
            continue
        o = options.get(exit_id.lower())
        if o is None:
            reasons.append(f"Exit '{exit_id}' is not one of {town}'s exits ({', '.join(x['id'] for x in options.values())}).")
        elif o["blocked_1h_at_km"] is not None:
            reasons.append(f"{o['id']} from {town} runs into the fire or the +1 h forecast fire "
                           f"{o['blocked_1h_at_km']} km from town.")
    return reasons, human


def plan(sit):
    """AI plan -> safety check -> retry with the reasons. Returns every attempt so the app can show REJECTED banners."""
    ctx = ai_context(sit)
    attempts, feedback = [], None
    for i in range(1 + MAX_RETRIES):
        try:
            r = ai.ask("plan", _plan_prompt(ctx, feedback), want_json=True)
        except ai.AIOffline as e:
            return {"status": "AI_OFFLINE", "attempts": attempts, "detail": str(e)[:200],
                    "message": "AI offline, forecast only (AI service busy or quota reached; cached answers still work)"}
        p = r["json"]
        reasons, human = safety_check(p, sit)
        attempts.append({"attempt": i + 1, "plan": p, "verdict": "REJECTED" if reasons else "ACCEPTED",
                         "reasons": reasons, "human_decisions": human,
                         "provider": r["provider"], "model": r["model"], "cached": r["cached"]})
        if not reasons:
            # Towns where EVERY highway exit runs into the fire: the AI's road is kept for the record but not shown
            # as the route, and the alert must not send people down it. A human chooses (escort, shelter, local roads).
            stuck = {t for t, opts in sit["exits"].items() if opts and all(o["blocked_1h_at_km"] is not None for o in opts)}
            for e in p.get("evacuate") or []:
                if isinstance(e, dict) and e.get("town") in stuck:
                    e["exit_ai"], e["exit"], e["needs_human"] = e.get("exit"), NO_CLEAR_EXIT, True
            return {"status": "ACCEPTED", "attempts": attempts, "plan": p, "human_decisions": human}
        feedback = reasons
    return {"status": "MANUAL", "attempts": attempts,
            "message": "Manual decision required: the AI plan failed the safety check 3 times."}


def alert(sit, approved_plan):
    ctx = {"fire": sit["name"], "time_local": sit["time_local"], "plan": approved_plan,
           "towns": [t for t in ai_context(sit)["towns"] if t["status"] in ("EVACUATE", "WARNING")]}
    prompt = ("Draft the Wireless Emergency Alert text an official would send through the county's existing alert "
              f"system for this APPROVED plan. Under {ALERT_MAX} characters, plain text, no emojis, no hashtags. Start "
              "with 'EVACUATION ORDER' or 'EVACUATION WARNING', name the fire, the town(s), the exit route(s) and a "
              "short action ('Leave now via ...'). If a town's exit is '" + NO_CLEAR_EXIT + "', do NOT name any road "
              "for that town: tell its residents to leave now and follow directions from emergency personnel. "
              "Do not invent phone numbers or links. Facts:\n" + json.dumps(ctx, default=str))
    r = ai.ask("alert", prompt)
    text = r["text"].strip().strip('"')
    if len(text) > ALERT_MAX:                          # hard limit: cut at the last full sentence that fits
        cut = text[:ALERT_MAX]
        text = cut[:cut.rfind(".") + 1] if "." in cut else cut
    return {**r, "text": text, "chars": len(text), "label": "Draft for county alert system, not sent"}


def triage_line(inc):
    prompt = ("In one line of at most 22 words, say why this wildfire incident ranks where it does for an emergency "
              "manager (people nearby, wind toward towns, growth). Facts: " + json.dumps(inc, default=str))
    return ai.ask("triage", prompt)
