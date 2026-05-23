"""app.workers — Phase 3D extracted worker packages.

Each subpackage owns exactly one worker, its cadence, its registration
hook, and its ownership boundary documentation. See
`/app/memory/PHASE_3D_EXTRACTION_SEQUENCE.md` for the extraction
sequence and per-PR contracts.

This package is intentionally minimal: it groups the extracted workers
without imposing any cross-worker abstraction. Each subpackage is
independent and may be moved (or rolled back) without touching siblings.
"""
