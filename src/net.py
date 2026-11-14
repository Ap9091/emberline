"""
Small download helper: try a web request several times before giving up.

Some servers (NASA FIRMS, Overpass) sometimes drop the connection, so one failure
does not mean the source is broken. We wait a bit longer after each failed try.
"""

import time

import requests


def get(url, tries=8, timeout=120, **kwargs):
    """requests.get with retries. Raises the last error if every try fails."""
    for attempt in range(1, tries + 1):
        try:
            r = requests.get(url, timeout=timeout, **kwargs)
            r.raise_for_status()
            return r
        except requests.RequestException as e:
            if attempt == tries:
                raise
            print(f"    (try {attempt} failed: {type(e).__name__}, retrying in {2 * attempt}s)")
            time.sleep(2 * attempt)


def post(url, tries=8, timeout=120, **kwargs):
    """requests.post with retries (used for Overpass queries)."""
    for attempt in range(1, tries + 1):
        try:
            r = requests.post(url, timeout=timeout, **kwargs)
            r.raise_for_status()
            return r
        except requests.RequestException as e:
            if attempt == tries:
                raise
            print(f"    (try {attempt} failed: {type(e).__name__}, retrying in {2 * attempt}s)")
            time.sleep(2 * attempt)


def retry(func, tries=5):
    """Call func() up to `tries` times (for SDK calls like Gemini that are not plain requests)."""
    for attempt in range(1, tries + 1):
        try:
            return func()
        except Exception as e:
            if attempt == tries:
                raise
            print(f"    (try {attempt} failed: {type(e).__name__}, retrying in {2 * attempt}s)")
            time.sleep(2 * attempt)
