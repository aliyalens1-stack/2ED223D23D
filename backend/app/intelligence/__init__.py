"""Draft Intelligence Engine (Sprint 2 Step 4).

Inspector no longer writes verdict and summary from scratch.
Runtime evidence → deterministic checks → Claude synthesis → structured draft.
Inspector verifies + edits + confirms.

Never blocks the report flow: if Claude is slow or returns malformed JSON,
fall back to deterministic-only draft (verdict computed from severity
distribution, summary auto-templated).
"""
