"""Great-circle distance helper for pricing projection.

We use the haversine formula on lat/lng pairs. This is the canonical
distance source for the entire pricing pipeline. Anything else (driving
distance, Google routes, etc.) is intentionally out of scope for v1 —
we'd lose pricing determinism.

The pricing projection MUST always quote the same number for the same
inputs, otherwise customer-frozen quotes drift between request and
acceptance.
"""
from __future__ import annotations
import math
from typing import Tuple


EARTH_RADIUS_KM = 6371.0088


def haversine_km(a: Tuple[float, float], b: Tuple[float, float]) -> float:
    """Return great-circle distance between two (lat, lng) points in kilometers.

    Inputs are (lat, lng) tuples in degrees. Output is rounded to 1 decimal —
    the projection layer further normalises this so quotes don't differ by
    a meter between sessions.
    """
    lat1, lon1 = a
    lat2, lon2 = b
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lon2 - lon1)
    h = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlam / 2) ** 2
    c = 2 * math.asin(math.sqrt(h))
    return round(EARTH_RADIUS_KM * c, 1)
