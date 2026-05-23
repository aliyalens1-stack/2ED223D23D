"""Vehicle Memory layer entry-point.

Sprint 2B-ish: introduces vehicle as a first-class entity, stored in the
`vehicles` Mongo collection, scoped to the customer that created it.

Scope discipline (per architectural review):
  - Vehicle exists independently of any request. One vehicle may be referenced
    by zero, one, or many requests over its lifetime.
  - This MVP intentionally does NOT implement: dedup, VIN normalization, trust
    score, vehicle graph edges, public inventory, org-shared vehicles, or
    ranking. All of those layers will be built on top of this entity later.
"""
from app.vehicles.router import router  # re-export for server.py
