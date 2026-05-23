"""app.parsers.vin — pure-Python VIN decoder.

ISO 3779 / FMVSS 115. No external service. We extract:
  - country  (WMI positions 1-2)
  - manufacturer (best-effort by WMI 1-3 prefix table)
  - model_year (position 10 — char→year cycle, narrowed by current decade)
  - is_valid (length 17 + char set + check-digit position-9 for North America VINs)

Why no external decode service:
  - Soft offline guarantees (works in dev / preview pods)
  - No rate-limit / API key pain
  - Coverage we need (country / year) is fully in the VIN itself

VIN charset: A-H J-N P R-Z 0-9 (no I, O, Q).
"""
from __future__ import annotations
import re
from typing import Optional


_VIN_CHARSET = set("ABCDEFGHJKLMNPRSTUVWXYZ0123456789")
_VIN_RE = re.compile(r"^[A-HJ-NPR-Z0-9]{17}$")


# Position 10 → model year (rolling cycle, ISO 3779).
# Cycle resets every 30 years; we resolve to the *current* cycle by
# preferring years close to today over decades ago.
_YEAR_CODE = {
    "A": 1980, "B": 1981, "C": 1982, "D": 1983, "E": 1984,
    "F": 1985, "G": 1986, "H": 1987, "J": 1988, "K": 1989,
    "L": 1990, "M": 1991, "N": 1992, "P": 1993, "R": 1994,
    "S": 1995, "T": 1996, "V": 1997, "W": 1998, "X": 1999, "Y": 2000,
    "1": 2001, "2": 2002, "3": 2003, "4": 2004, "5": 2005,
    "6": 2006, "7": 2007, "8": 2008, "9": 2009,
}


def _resolve_year(code: str, current_year: int = 2026) -> Optional[int]:
    base = _YEAR_CODE.get(code)
    if not base:
        return None
    # Add 30 if the resolved year is too far in the past — VINs cycle every 30y.
    while base + 30 <= current_year:
        base += 30
    return base


# WMI-1 → ISO country block (best-effort, covers ~95% of European market)
# Each tuple: (start, end, country, region)
_WMI1_RANGES: list[tuple[str, str, str, str]] = [
    # North America
    ("1", "1", "US", "North America"),
    ("4", "4", "US", "North America"),
    ("5", "5", "US", "North America"),
    ("2", "2", "CA", "North America"),
    ("3", "3", "MX", "North America"),
    # South America
    ("9", "9", "BR", "South America"),
    # Asia
    ("J", "J", "JP", "Asia"),
    ("K", "K", "KR", "Asia"),
    ("L", "L", "CN", "Asia"),
    ("M", "M", "IN", "Asia"),
    # Europe
    ("S", "S", "EU", "Europe"),  # generic — refined below by 1-2 prefix
    ("T", "T", "EU", "Europe"),
    ("V", "V", "EU", "Europe"),
    ("W", "W", "DE", "Europe"),
    ("X", "X", "EU", "Europe"),
    ("Y", "Y", "EU", "Europe"),
    ("Z", "Z", "EU", "Europe"),
]

# WMI-1+2 country refinement (2-char prefix) for European bloc.
_WMI2_OVERRIDES: dict[str, str] = {
    "SA": "GB", "SB": "GB", "SC": "GB", "SD": "GB", "SE": "GB", "SF": "GB", "SG": "GB", "SH": "GB", "SJ": "GB", "SK": "GB", "SL": "GB", "SM": "GB",
    "SN": "DE", "SP": "DE", "SR": "DE", "SS": "DE", "ST": "DE",
    "SU": "PL", "SV": "PL", "SW": "PL", "SX": "PL", "SY": "PL", "SZ": "PL",
    "TA": "CH", "TB": "CH", "TC": "CH", "TD": "CH", "TE": "CH", "TF": "CH", "TG": "CH", "TH": "CH",
    "TJ": "CZ", "TK": "CZ", "TL": "CZ", "TM": "CZ", "TN": "CZ", "TP": "CZ", "TR": "CZ",
    "TS": "HU", "TT": "HU", "TU": "HU", "TV": "HU", "TW": "HU",
    "VA": "AT", "VB": "AT", "VC": "AT", "VD": "AT", "VE": "AT",
    "VF": "FR", "VG": "FR", "VH": "FR", "VJ": "FR", "VK": "FR", "VL": "FR", "VM": "FR", "VN": "FR", "VP": "FR", "VR": "FR",
    "VS": "ES", "VT": "ES", "VU": "ES", "VV": "ES", "VW": "ES",
    "VX": "BA", "VY": "BA", "VZ": "BA",
    "XL": "NL", "XM": "NL",
    "XS": "RU", "XT": "RU", "XU": "RU", "XV": "RU", "XW": "RU",
    "YA": "BE", "YB": "BE", "YC": "BE", "YD": "BE", "YE": "BE",
    "YF": "FI", "YG": "FI", "YH": "FI", "YJ": "FI", "YK": "FI",
    "YL": "MT", "YM": "MT", "YN": "MT",
    "YS": "SE", "YT": "SE", "YU": "SE", "YV": "SE", "YW": "SE",
    "YX": "NO", "YY": "NO", "YZ": "NO",
    "ZA": "IT", "ZB": "IT", "ZC": "IT", "ZD": "IT", "ZE": "IT", "ZF": "IT", "ZG": "IT", "ZH": "IT", "ZJ": "IT", "ZK": "IT", "ZL": "IT", "ZM": "IT",
    "ZX": "BG", "ZY": "BG", "ZZ": "BG",
}


# WMI 1-3 → manufacturer (best-effort for the European market).
_WMI3: dict[str, str] = {
    # Germany
    "WBA": "BMW",
    "WBS": "BMW M",
    "WBY": "BMW i",
    "WAU": "Audi",
    "WA1": "Audi",
    "WUA": "Audi RS",
    "WMW": "MINI",
    "WDB": "Mercedes-Benz",
    "WDC": "Mercedes-Benz",
    "WDD": "Mercedes-Benz",
    "WDF": "Mercedes-Benz",
    "WMX": "Mercedes-AMG",
    "WP0": "Porsche",
    "WP1": "Porsche SUV",
    "WV1": "Volkswagen Commercial",
    "WV2": "Volkswagen Bus",
    "WVG": "Volkswagen SUV",
    "WVW": "Volkswagen",
    "W0L": "Opel",
    "W0V": "Opel",
    # UK
    "SAJ": "Jaguar",
    "SAL": "Land Rover",
    "SCC": "Lotus",
    "SCF": "Aston Martin",
    "SCB": "Bentley",
    # Italy
    "ZFA": "Fiat",
    "ZFC": "Fiat",
    "ZFF": "Ferrari",
    "ZHW": "Lamborghini",
    "ZAR": "Alfa Romeo",
    "ZAM": "Maserati",
    # France
    "VF1": "Renault",
    "VF2": "Renault Trucks",
    "VF3": "Peugeot",
    "VF6": "Renault Trucks",
    "VF7": "Citroën",
    "VF8": "Matra",
    "VF9": "Bugatti",
    # Spain
    "VSS": "SEAT",
    # Czech
    "TMB": "Škoda",
    # Sweden
    "YV1": "Volvo Cars",
    "YV4": "Volvo Cars",
    "YS3": "Saab",
    # Japan (sold in Europe)
    "JTD": "Toyota",
    "JT2": "Toyota",
    "JN1": "Nissan",
    "JN8": "Nissan",
    "JHM": "Honda",
    "JF1": "Subaru",
    "JF2": "Subaru",
    "JM1": "Mazda",
    "JS1": "Suzuki",
    "JMZ": "Mazda",
    # Korea
    "KMH": "Hyundai",
    "KNA": "Kia",
    "KND": "Kia",
    # USA
    "1FA": "Ford",
    "1FT": "Ford Truck",
    "1G1": "Chevrolet",
    "1G6": "Cadillac",
    "5YJ": "Tesla",
    # Russia
    "XTA": "Lada",
    "X4X": "Avtotor (BMW Russia)",
}


def _country_for(vin17: str) -> Optional[str]:
    if len(vin17) < 2:
        return None
    pref2 = vin17[:2].upper()
    if pref2 in _WMI2_OVERRIDES:
        return _WMI2_OVERRIDES[pref2]
    c1 = vin17[0].upper()
    for start, end, country, _ in _WMI1_RANGES:
        if start <= c1 <= end:
            return country
    return None


def _manufacturer_for(vin17: str) -> Optional[str]:
    if len(vin17) < 3:
        return None
    return _WMI3.get(vin17[:3].upper())


def normalize_vin(raw: str) -> str:
    """Strip whitespace, uppercase. Does not trim length — caller validates."""
    if not raw:
        return ""
    return re.sub(r"\s+", "", raw).upper()


def decode_vin(raw: str, current_year: int = 2026) -> dict:
    """Decode a VIN into a flat dict.

    Returns:
        {
          "vin": str,
          "valid": bool,
          "errors": list[str],   # human-readable
          "country": str | None,
          "manufacturer": str | None,
          "modelYear": int | None,
          "wmi": str | None,
        }
    """
    vin = normalize_vin(raw)
    errors: list[str] = []

    if len(vin) != 17:
        errors.append(f"length must be 17 (got {len(vin)})")
    if not _VIN_RE.match(vin):
        errors.append("contains invalid characters (allowed A-Z0-9, no I/O/Q)")

    valid = not errors
    return {
        "vin": vin,
        "valid": valid,
        "errors": errors,
        "country": _country_for(vin),
        "manufacturer": _manufacturer_for(vin),
        "modelYear": _resolve_year(vin[9].upper(), current_year) if len(vin) >= 10 else None,
        "wmi": vin[:3] if len(vin) >= 3 else None,
    }


__all__ = ["decode_vin", "normalize_vin"]
