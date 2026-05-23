"""
Stage 2 — Geo + Search.
Cities catalogue + city filter for organizations.

- Static catalogue covering Germany, Austria, Ukraine, Latvia, Lithuania,
  Estonia and Belarus (5+ countries, ~90 cities).
- Each city has center coordinates → frontend uses them for
  `/marketplace/providers?lat=&lng=`.
- Extends existing `/api/marketplace/providers` via `?city=` filter.
- Migrates existing orgs by inferring city from address/coords on first call.
"""
from typing import List, Optional
from fastapi import APIRouter, Depends
from pydantic import BaseModel
from server import db  # shared Motor handle
from app.core.redis_state import rate_limit_public  # public RL dep

router = APIRouter(tags=["geo"])


class City(BaseModel):
    code: str          # short id used in URLs and AsyncStorage
    name: str          # display name (i18n done client-side)
    country: str       # ISO-2 country code
    lat: float
    lng: float
    timezone: str
    currency: str      # display currency hint
    providersCount: int = 0
    aliases: List[str] = []  # alternative spellings for search


# Static catalogue. Adding more = just append + re-deploy.
# Country expansion 2026-05-17: DE/AT/UA/LV/LT/EE/BY (~90 cities).
# All keys lowercased; addressMarkers used both for migration and search aliases.
CITY_CATALOGUE: List[dict] = [
    # ── DE Tier 1 (top metros) ────────────────────────────────────────────
    {"code": "berlin",     "name": "Berlin",            "country": "DE", "lat": 52.5200, "lng": 13.4050, "timezone": "Europe/Berlin", "currency": "EUR", "addressMarkers": ["Berlin"]},
    {"code": "hamburg",    "name": "Hamburg",           "country": "DE", "lat": 53.5511, "lng":  9.9937, "timezone": "Europe/Berlin", "currency": "EUR", "addressMarkers": ["Hamburg"]},
    {"code": "munich",     "name": "München",           "country": "DE", "lat": 48.1351, "lng": 11.5820, "timezone": "Europe/Berlin", "currency": "EUR", "addressMarkers": ["München", "Munich", "Muenchen"]},
    {"code": "cologne",    "name": "Köln",              "country": "DE", "lat": 50.9375, "lng":  6.9603, "timezone": "Europe/Berlin", "currency": "EUR", "addressMarkers": ["Köln", "Koeln", "Cologne"]},
    {"code": "frankfurt",  "name": "Frankfurt am Main", "country": "DE", "lat": 50.1109, "lng":  8.6821, "timezone": "Europe/Berlin", "currency": "EUR", "addressMarkers": ["Frankfurt am Main", "Frankfurt"]},
    {"code": "stuttgart",  "name": "Stuttgart",         "country": "DE", "lat": 48.7758, "lng":  9.1829, "timezone": "Europe/Berlin", "currency": "EUR", "addressMarkers": ["Stuttgart"]},
    {"code": "dusseldorf", "name": "Düsseldorf",        "country": "DE", "lat": 51.2277, "lng":  6.7735, "timezone": "Europe/Berlin", "currency": "EUR", "addressMarkers": ["Düsseldorf", "Duesseldorf", "Dusseldorf"]},
    {"code": "leipzig",    "name": "Leipzig",           "country": "DE", "lat": 51.3397, "lng": 12.3731, "timezone": "Europe/Berlin", "currency": "EUR", "addressMarkers": ["Leipzig"]},
    {"code": "dortmund",   "name": "Dortmund",          "country": "DE", "lat": 51.5136, "lng":  7.4653, "timezone": "Europe/Berlin", "currency": "EUR", "addressMarkers": ["Dortmund"]},
    {"code": "essen",      "name": "Essen",             "country": "DE", "lat": 51.4556, "lng":  7.0116, "timezone": "Europe/Berlin", "currency": "EUR", "addressMarkers": ["Essen"]},
    {"code": "bremen",     "name": "Bremen",            "country": "DE", "lat": 53.0793, "lng":  8.8017, "timezone": "Europe/Berlin", "currency": "EUR", "addressMarkers": ["Bremen"]},
    {"code": "dresden",    "name": "Dresden",           "country": "DE", "lat": 51.0504, "lng": 13.7373, "timezone": "Europe/Berlin", "currency": "EUR", "addressMarkers": ["Dresden"]},
    {"code": "hannover",   "name": "Hannover",          "country": "DE", "lat": 52.3759, "lng":  9.7320, "timezone": "Europe/Berlin", "currency": "EUR", "addressMarkers": ["Hannover", "Hanover"]},
    {"code": "nuremberg",  "name": "Nürnberg",          "country": "DE", "lat": 49.4521, "lng": 11.0767, "timezone": "Europe/Berlin", "currency": "EUR", "addressMarkers": ["Nürnberg", "Nuremberg", "Nuernberg"]},
    {"code": "duisburg",   "name": "Duisburg",          "country": "DE", "lat": 51.4344, "lng":  6.7623, "timezone": "Europe/Berlin", "currency": "EUR", "addressMarkers": ["Duisburg"]},
    {"code": "bochum",     "name": "Bochum",            "country": "DE", "lat": 51.4818, "lng":  7.2162, "timezone": "Europe/Berlin", "currency": "EUR", "addressMarkers": ["Bochum"]},
    {"code": "wuppertal",  "name": "Wuppertal",         "country": "DE", "lat": 51.2562, "lng":  7.1508, "timezone": "Europe/Berlin", "currency": "EUR", "addressMarkers": ["Wuppertal"]},
    {"code": "bielefeld",  "name": "Bielefeld",         "country": "DE", "lat": 52.0302, "lng":  8.5325, "timezone": "Europe/Berlin", "currency": "EUR", "addressMarkers": ["Bielefeld"]},
    {"code": "bonn",       "name": "Bonn",              "country": "DE", "lat": 50.7374, "lng":  7.0982, "timezone": "Europe/Berlin", "currency": "EUR", "addressMarkers": ["Bonn"]},
    {"code": "muenster",   "name": "Münster",           "country": "DE", "lat": 51.9607, "lng":  7.6261, "timezone": "Europe/Berlin", "currency": "EUR", "addressMarkers": ["Münster", "Muenster"]},
    # ── DE Tier 2 (additional hubs) ───────────────────────────────────────
    {"code": "karlsruhe",  "name": "Karlsruhe",         "country": "DE", "lat": 49.0069, "lng":  8.4037, "timezone": "Europe/Berlin", "currency": "EUR", "addressMarkers": ["Karlsruhe"]},
    {"code": "mannheim",   "name": "Mannheim",          "country": "DE", "lat": 49.4875, "lng":  8.4660, "timezone": "Europe/Berlin", "currency": "EUR", "addressMarkers": ["Mannheim"]},
    {"code": "augsburg",   "name": "Augsburg",          "country": "DE", "lat": 48.3705, "lng": 10.8978, "timezone": "Europe/Berlin", "currency": "EUR", "addressMarkers": ["Augsburg"]},
    {"code": "wiesbaden",  "name": "Wiesbaden",         "country": "DE", "lat": 50.0782, "lng":  8.2398, "timezone": "Europe/Berlin", "currency": "EUR", "addressMarkers": ["Wiesbaden"]},
    {"code": "aachen",     "name": "Aachen",            "country": "DE", "lat": 50.7753, "lng":  6.0839, "timezone": "Europe/Berlin", "currency": "EUR", "addressMarkers": ["Aachen", "Aix-la-Chapelle"]},
    {"code": "kiel",       "name": "Kiel",              "country": "DE", "lat": 54.3233, "lng": 10.1228, "timezone": "Europe/Berlin", "currency": "EUR", "addressMarkers": ["Kiel"]},
    {"code": "lubeck",     "name": "Lübeck",            "country": "DE", "lat": 53.8655, "lng": 10.6866, "timezone": "Europe/Berlin", "currency": "EUR", "addressMarkers": ["Lübeck", "Luebeck", "Lubeck"]},
    {"code": "rostock",    "name": "Rostock",           "country": "DE", "lat": 54.0887, "lng": 12.1418, "timezone": "Europe/Berlin", "currency": "EUR", "addressMarkers": ["Rostock"]},
    {"code": "freiburg",   "name": "Freiburg im Breisgau", "country": "DE", "lat": 47.9990, "lng":  7.8421, "timezone": "Europe/Berlin", "currency": "EUR", "addressMarkers": ["Freiburg"]},
    {"code": "mainz",      "name": "Mainz",             "country": "DE", "lat": 49.9929, "lng":  8.2473, "timezone": "Europe/Berlin", "currency": "EUR", "addressMarkers": ["Mainz"]},
    {"code": "erfurt",     "name": "Erfurt",            "country": "DE", "lat": 50.9848, "lng": 11.0299, "timezone": "Europe/Berlin", "currency": "EUR", "addressMarkers": ["Erfurt"]},
    {"code": "potsdam",    "name": "Potsdam",           "country": "DE", "lat": 52.3906, "lng": 13.0645, "timezone": "Europe/Berlin", "currency": "EUR", "addressMarkers": ["Potsdam"]},

    # ── AT (Austria) ─────────────────────────────────────────────────────
    {"code": "vienna",     "name": "Wien",              "country": "AT", "lat": 48.2082, "lng": 16.3738, "timezone": "Europe/Vienna", "currency": "EUR", "addressMarkers": ["Wien", "Vienna"]},
    {"code": "graz",       "name": "Graz",              "country": "AT", "lat": 47.0707, "lng": 15.4395, "timezone": "Europe/Vienna", "currency": "EUR", "addressMarkers": ["Graz"]},
    {"code": "linz",       "name": "Linz",              "country": "AT", "lat": 48.3064, "lng": 14.2858, "timezone": "Europe/Vienna", "currency": "EUR", "addressMarkers": ["Linz"]},
    {"code": "salzburg",   "name": "Salzburg",          "country": "AT", "lat": 47.8095, "lng": 13.0550, "timezone": "Europe/Vienna", "currency": "EUR", "addressMarkers": ["Salzburg"]},
    {"code": "innsbruck",  "name": "Innsbruck",         "country": "AT", "lat": 47.2692, "lng": 11.4041, "timezone": "Europe/Vienna", "currency": "EUR", "addressMarkers": ["Innsbruck"]},
    {"code": "klagenfurt", "name": "Klagenfurt",        "country": "AT", "lat": 46.6247, "lng": 14.3050, "timezone": "Europe/Vienna", "currency": "EUR", "addressMarkers": ["Klagenfurt"]},

    # ── UA (Ukraine) ──────────────────────────────────────────────────────
    {"code": "kyiv",       "name": "Київ",              "country": "UA", "lat": 50.4501, "lng": 30.5234, "timezone": "Europe/Kyiv", "currency": "UAH", "addressMarkers": ["Київ", "Киев", "Kyiv", "Kiev"]},
    {"code": "kharkiv",    "name": "Харків",            "country": "UA", "lat": 49.9935, "lng": 36.2304, "timezone": "Europe/Kyiv", "currency": "UAH", "addressMarkers": ["Харків", "Харьков", "Kharkiv", "Kharkov"]},
    {"code": "dnipro",     "name": "Дніпро",            "country": "UA", "lat": 48.4647, "lng": 35.0462, "timezone": "Europe/Kyiv", "currency": "UAH", "addressMarkers": ["Дніпро", "Днепр", "Dnipro"]},
    {"code": "odesa",      "name": "Одеса",             "country": "UA", "lat": 46.4825, "lng": 30.7233, "timezone": "Europe/Kyiv", "currency": "UAH", "addressMarkers": ["Одеса", "Одесса", "Odesa", "Odessa"]},
    {"code": "lviv",       "name": "Львів",             "country": "UA", "lat": 49.8397, "lng": 24.0297, "timezone": "Europe/Kyiv", "currency": "UAH", "addressMarkers": ["Львів", "Львов", "Lviv", "Lvov"]},
    {"code": "zaporizhzhia","name": "Запоріжжя",        "country": "UA", "lat": 47.8388, "lng": 35.1396, "timezone": "Europe/Kyiv", "currency": "UAH", "addressMarkers": ["Запоріжжя", "Запорожье", "Zaporizhzhia"]},
    {"code": "vinnytsia",  "name": "Вінниця",           "country": "UA", "lat": 49.2331, "lng": 28.4682, "timezone": "Europe/Kyiv", "currency": "UAH", "addressMarkers": ["Вінниця", "Винница", "Vinnytsia"]},
    {"code": "poltava",    "name": "Полтава",           "country": "UA", "lat": 49.5883, "lng": 34.5514, "timezone": "Europe/Kyiv", "currency": "UAH", "addressMarkers": ["Полтава", "Poltava"]},
    {"code": "chernivtsi", "name": "Чернівці",          "country": "UA", "lat": 48.2921, "lng": 25.9358, "timezone": "Europe/Kyiv", "currency": "UAH", "addressMarkers": ["Чернівці", "Черновцы", "Chernivtsi"]},
    {"code": "ivano-frankivsk","name": "Івано-Франківськ", "country": "UA", "lat": 48.9226, "lng": 24.7111, "timezone": "Europe/Kyiv", "currency": "UAH", "addressMarkers": ["Івано-Франківськ", "Ивано-Франковск", "Ivano-Frankivsk"]},
    {"code": "ternopil",   "name": "Тернопіль",         "country": "UA", "lat": 49.5535, "lng": 25.5948, "timezone": "Europe/Kyiv", "currency": "UAH", "addressMarkers": ["Тернопіль", "Тернополь", "Ternopil"]},
    {"code": "khmelnytskyi","name": "Хмельницький",     "country": "UA", "lat": 49.4229, "lng": 26.9871, "timezone": "Europe/Kyiv", "currency": "UAH", "addressMarkers": ["Хмельницький", "Хмельницкий", "Khmelnytskyi"]},
    {"code": "cherkasy",   "name": "Черкаси",           "country": "UA", "lat": 49.4444, "lng": 32.0598, "timezone": "Europe/Kyiv", "currency": "UAH", "addressMarkers": ["Черкаси", "Черкассы", "Cherkasy"]},
    {"code": "zhytomyr",   "name": "Житомир",           "country": "UA", "lat": 50.2547, "lng": 28.6587, "timezone": "Europe/Kyiv", "currency": "UAH", "addressMarkers": ["Житомир", "Zhytomyr"]},
    {"code": "sumy",       "name": "Суми",              "country": "UA", "lat": 50.9077, "lng": 34.7981, "timezone": "Europe/Kyiv", "currency": "UAH", "addressMarkers": ["Суми", "Сумы", "Sumy"]},
    {"code": "rivne",      "name": "Рівне",             "country": "UA", "lat": 50.6199, "lng": 26.2516, "timezone": "Europe/Kyiv", "currency": "UAH", "addressMarkers": ["Рівне", "Ровно", "Rivne"]},
    {"code": "lutsk",      "name": "Луцьк",             "country": "UA", "lat": 50.7472, "lng": 25.3254, "timezone": "Europe/Kyiv", "currency": "UAH", "addressMarkers": ["Луцьк", "Луцк", "Lutsk"]},
    {"code": "uzhhorod",   "name": "Ужгород",           "country": "UA", "lat": 48.6208, "lng": 22.2879, "timezone": "Europe/Kyiv", "currency": "UAH", "addressMarkers": ["Ужгород", "Uzhhorod", "Uzhgorod"]},
    {"code": "mykolaiv",   "name": "Миколаїв",          "country": "UA", "lat": 46.9750, "lng": 31.9946, "timezone": "Europe/Kyiv", "currency": "UAH", "addressMarkers": ["Миколаїв", "Николаев", "Mykolaiv"]},
    {"code": "chernihiv",  "name": "Чернігів",          "country": "UA", "lat": 51.4982, "lng": 31.2893, "timezone": "Europe/Kyiv", "currency": "UAH", "addressMarkers": ["Чернігів", "Чернигов", "Chernihiv"]},
    {"code": "kropyvnytskyi","name": "Кропивницький",  "country": "UA", "lat": 48.5079, "lng": 32.2623, "timezone": "Europe/Kyiv", "currency": "UAH", "addressMarkers": ["Кропивницький", "Кировоград", "Kropyvnytskyi"]},

    # ── LV (Latvia) ───────────────────────────────────────────────────────
    {"code": "riga",       "name": "Rīga",              "country": "LV", "lat": 56.9496, "lng": 24.1052, "timezone": "Europe/Riga", "currency": "EUR", "addressMarkers": ["Rīga", "Riga", "Рига"]},
    {"code": "daugavpils", "name": "Daugavpils",        "country": "LV", "lat": 55.8748, "lng": 26.5364, "timezone": "Europe/Riga", "currency": "EUR", "addressMarkers": ["Daugavpils", "Даугавпилс"]},
    {"code": "liepaja",    "name": "Liepāja",           "country": "LV", "lat": 56.5111, "lng": 21.0136, "timezone": "Europe/Riga", "currency": "EUR", "addressMarkers": ["Liepāja", "Liepaja", "Лиепая"]},
    {"code": "jelgava",    "name": "Jelgava",           "country": "LV", "lat": 56.6500, "lng": 23.7129, "timezone": "Europe/Riga", "currency": "EUR", "addressMarkers": ["Jelgava", "Елгава"]},
    {"code": "jurmala",    "name": "Jūrmala",           "country": "LV", "lat": 56.9680, "lng": 23.7704, "timezone": "Europe/Riga", "currency": "EUR", "addressMarkers": ["Jūrmala", "Jurmala", "Юрмала"]},
    {"code": "ventspils",  "name": "Ventspils",         "country": "LV", "lat": 57.3895, "lng": 21.5606, "timezone": "Europe/Riga", "currency": "EUR", "addressMarkers": ["Ventspils", "Вентспилс"]},
    {"code": "rezekne",    "name": "Rēzekne",           "country": "LV", "lat": 56.5079, "lng": 27.3320, "timezone": "Europe/Riga", "currency": "EUR", "addressMarkers": ["Rēzekne", "Rezekne", "Резекне"]},
    {"code": "valmiera",   "name": "Valmiera",          "country": "LV", "lat": 57.5333, "lng": 25.4275, "timezone": "Europe/Riga", "currency": "EUR", "addressMarkers": ["Valmiera", "Валмиера"]},

    # ── LT (Lithuania) ────────────────────────────────────────────────────
    {"code": "vilnius",    "name": "Vilnius",           "country": "LT", "lat": 54.6872, "lng": 25.2797, "timezone": "Europe/Vilnius", "currency": "EUR", "addressMarkers": ["Vilnius", "Вильнюс"]},
    {"code": "kaunas",     "name": "Kaunas",            "country": "LT", "lat": 54.8985, "lng": 23.9036, "timezone": "Europe/Vilnius", "currency": "EUR", "addressMarkers": ["Kaunas", "Каунас"]},
    {"code": "klaipeda",   "name": "Klaipėda",          "country": "LT", "lat": 55.7033, "lng": 21.1443, "timezone": "Europe/Vilnius", "currency": "EUR", "addressMarkers": ["Klaipėda", "Klaipeda", "Клайпеда"]},
    {"code": "siauliai",   "name": "Šiauliai",          "country": "LT", "lat": 55.9333, "lng": 23.3167, "timezone": "Europe/Vilnius", "currency": "EUR", "addressMarkers": ["Šiauliai", "Siauliai", "Шяуляй"]},
    {"code": "panevezys",  "name": "Panevėžys",         "country": "LT", "lat": 55.7333, "lng": 24.3500, "timezone": "Europe/Vilnius", "currency": "EUR", "addressMarkers": ["Panevėžys", "Panevezys", "Паневежис"]},
    {"code": "alytus",     "name": "Alytus",            "country": "LT", "lat": 54.3964, "lng": 24.0464, "timezone": "Europe/Vilnius", "currency": "EUR", "addressMarkers": ["Alytus", "Алитус"]},
    {"code": "marijampole","name": "Marijampolė",       "country": "LT", "lat": 54.5560, "lng": 23.3539, "timezone": "Europe/Vilnius", "currency": "EUR", "addressMarkers": ["Marijampolė", "Marijampole", "Мариямполе"]},
    {"code": "mazeikiai",  "name": "Mažeikiai",         "country": "LT", "lat": 56.3097, "lng": 22.3417, "timezone": "Europe/Vilnius", "currency": "EUR", "addressMarkers": ["Mažeikiai", "Mazeikiai", "Мажейкяй"]},

    # ── EE (Estonia) ──────────────────────────────────────────────────────
    {"code": "tallinn",    "name": "Tallinn",           "country": "EE", "lat": 59.4370, "lng": 24.7536, "timezone": "Europe/Tallinn", "currency": "EUR", "addressMarkers": ["Tallinn", "Таллин"]},
    {"code": "tartu",      "name": "Tartu",             "country": "EE", "lat": 58.3776, "lng": 26.7290, "timezone": "Europe/Tallinn", "currency": "EUR", "addressMarkers": ["Tartu", "Тарту"]},
    {"code": "narva",      "name": "Narva",             "country": "EE", "lat": 59.3776, "lng": 28.1903, "timezone": "Europe/Tallinn", "currency": "EUR", "addressMarkers": ["Narva", "Нарва"]},
    {"code": "parnu",      "name": "Pärnu",             "country": "EE", "lat": 58.3859, "lng": 24.4971, "timezone": "Europe/Tallinn", "currency": "EUR", "addressMarkers": ["Pärnu", "Parnu", "Пярну"]},
    {"code": "kohtla-jarve","name": "Kohtla-Järve",     "country": "EE", "lat": 59.3987, "lng": 27.2733, "timezone": "Europe/Tallinn", "currency": "EUR", "addressMarkers": ["Kohtla-Järve", "Kohtla-Jarve", "Кохтла-Ярве"]},
    {"code": "viljandi",   "name": "Viljandi",          "country": "EE", "lat": 58.3636, "lng": 25.5900, "timezone": "Europe/Tallinn", "currency": "EUR", "addressMarkers": ["Viljandi", "Вильянди"]},
    {"code": "rakvere",    "name": "Rakvere",           "country": "EE", "lat": 59.3464, "lng": 26.3556, "timezone": "Europe/Tallinn", "currency": "EUR", "addressMarkers": ["Rakvere", "Раквере"]},

    # ── BY (Belarus) ──────────────────────────────────────────────────────
    {"code": "minsk",      "name": "Минск",             "country": "BY", "lat": 53.9006, "lng": 27.5590, "timezone": "Europe/Minsk", "currency": "BYN", "addressMarkers": ["Минск", "Мінск", "Minsk"]},
    {"code": "brest",      "name": "Брест",             "country": "BY", "lat": 52.0976, "lng": 23.7341, "timezone": "Europe/Minsk", "currency": "BYN", "addressMarkers": ["Брест", "Brest"]},
    {"code": "grodno",     "name": "Гродно",            "country": "BY", "lat": 53.6694, "lng": 23.8131, "timezone": "Europe/Minsk", "currency": "BYN", "addressMarkers": ["Гродно", "Гродна", "Grodno", "Hrodna"]},
    {"code": "gomel",      "name": "Гомель",            "country": "BY", "lat": 52.4345, "lng": 30.9754, "timezone": "Europe/Minsk", "currency": "BYN", "addressMarkers": ["Гомель", "Homel", "Gomel"]},
    {"code": "mogilev",    "name": "Могилёв",           "country": "BY", "lat": 53.9006, "lng": 30.3322, "timezone": "Europe/Minsk", "currency": "BYN", "addressMarkers": ["Могилёв", "Магілёў", "Mogilev", "Mahilyow"]},
    {"code": "vitebsk",    "name": "Витебск",           "country": "BY", "lat": 55.1904, "lng": 30.2049, "timezone": "Europe/Minsk", "currency": "BYN", "addressMarkers": ["Витебск", "Віцебск", "Vitebsk", "Vitsebsk"]},
    {"code": "bobruisk",   "name": "Бобруйск",          "country": "BY", "lat": 53.1384, "lng": 29.2214, "timezone": "Europe/Minsk", "currency": "BYN", "addressMarkers": ["Бобруйск", "Бабруйск", "Bobruisk", "Babruysk"]},
    {"code": "baranovichi","name": "Барановичи",        "country": "BY", "lat": 53.1327, "lng": 26.0139, "timezone": "Europe/Minsk", "currency": "BYN", "addressMarkers": ["Барановичи", "Баранавічы", "Baranovichi"]},
    {"code": "borisov",    "name": "Борисов",           "country": "BY", "lat": 54.2278, "lng": 28.5053, "timezone": "Europe/Minsk", "currency": "BYN", "addressMarkers": ["Борисов", "Барысаў", "Borisov", "Barysaw"]},
    {"code": "pinsk",      "name": "Пинск",             "country": "BY", "lat": 52.1229, "lng": 26.0951, "timezone": "Europe/Minsk", "currency": "BYN", "addressMarkers": ["Пинск", "Пінск", "Pinsk"]},
    {"code": "orsha",      "name": "Орша",              "country": "BY", "lat": 54.5081, "lng": 30.4172, "timezone": "Europe/Minsk", "currency": "BYN", "addressMarkers": ["Орша", "Orsha"]},
    {"code": "soligorsk",  "name": "Солигорск",         "country": "BY", "lat": 52.7878, "lng": 27.5419, "timezone": "Europe/Minsk", "currency": "BYN", "addressMarkers": ["Солигорск", "Салігорск", "Soligorsk"]},
    {"code": "molodechno", "name": "Молодечно",         "country": "BY", "lat": 54.3167, "lng": 26.8500, "timezone": "Europe/Minsk", "currency": "BYN", "addressMarkers": ["Молодечно", "Маладзечна", "Molodechno"]},
    {"code": "novopolotsk","name": "Новополоцк",        "country": "BY", "lat": 55.5333, "lng": 28.6500, "timezone": "Europe/Minsk", "currency": "BYN", "addressMarkers": ["Новополоцк", "Наваполацк", "Novopolotsk"]},

    # ── PL (Poland) ───────────────────────────────────────────────────────
    {"code": "warsaw",     "name": "Warszawa",          "country": "PL", "lat": 52.2297, "lng": 21.0122, "timezone": "Europe/Warsaw", "currency": "PLN", "addressMarkers": ["Warszawa", "Warsaw", "Варшава"]},
    {"code": "krakow",     "name": "Kraków",            "country": "PL", "lat": 50.0647, "lng": 19.9450, "timezone": "Europe/Warsaw", "currency": "PLN", "addressMarkers": ["Kraków", "Krakow", "Краков"]},
    {"code": "lodz",       "name": "Łódź",              "country": "PL", "lat": 51.7592, "lng": 19.4560, "timezone": "Europe/Warsaw", "currency": "PLN", "addressMarkers": ["Łódź", "Lodz", "Лодзь"]},
    {"code": "wroclaw",    "name": "Wrocław",           "country": "PL", "lat": 51.1079, "lng": 17.0385, "timezone": "Europe/Warsaw", "currency": "PLN", "addressMarkers": ["Wrocław", "Wroclaw", "Вроцлав"]},
    {"code": "poznan",     "name": "Poznań",            "country": "PL", "lat": 52.4064, "lng": 16.9252, "timezone": "Europe/Warsaw", "currency": "PLN", "addressMarkers": ["Poznań", "Poznan", "Познань"]},
    {"code": "gdansk",     "name": "Gdańsk",            "country": "PL", "lat": 54.3520, "lng": 18.6466, "timezone": "Europe/Warsaw", "currency": "PLN", "addressMarkers": ["Gdańsk", "Gdansk", "Гданьск"]},
    {"code": "szczecin",   "name": "Szczecin",          "country": "PL", "lat": 53.4285, "lng": 14.5528, "timezone": "Europe/Warsaw", "currency": "PLN", "addressMarkers": ["Szczecin", "Щецин"]},
    {"code": "bydgoszcz",  "name": "Bydgoszcz",         "country": "PL", "lat": 53.1235, "lng": 18.0084, "timezone": "Europe/Warsaw", "currency": "PLN", "addressMarkers": ["Bydgoszcz", "Быдгощ"]},
    {"code": "lublin",     "name": "Lublin",            "country": "PL", "lat": 51.2465, "lng": 22.5684, "timezone": "Europe/Warsaw", "currency": "PLN", "addressMarkers": ["Lublin", "Люблин"]},
    {"code": "bialystok",  "name": "Białystok",         "country": "PL", "lat": 53.1325, "lng": 23.1688, "timezone": "Europe/Warsaw", "currency": "PLN", "addressMarkers": ["Białystok", "Bialystok", "Белосток"]},
    {"code": "katowice",   "name": "Katowice",          "country": "PL", "lat": 50.2649, "lng": 19.0238, "timezone": "Europe/Warsaw", "currency": "PLN", "addressMarkers": ["Katowice", "Катовице"]},
    {"code": "gdynia",     "name": "Gdynia",            "country": "PL", "lat": 54.5189, "lng": 18.5305, "timezone": "Europe/Warsaw", "currency": "PLN", "addressMarkers": ["Gdynia", "Гдыня"]},
    {"code": "czestochowa","name": "Częstochowa",       "country": "PL", "lat": 50.8118, "lng": 19.1203, "timezone": "Europe/Warsaw", "currency": "PLN", "addressMarkers": ["Częstochowa", "Czestochowa", "Ченстохова"]},
    {"code": "radom",      "name": "Radom",             "country": "PL", "lat": 51.4027, "lng": 21.1471, "timezone": "Europe/Warsaw", "currency": "PLN", "addressMarkers": ["Radom", "Радом"]},
    {"code": "rzeszow",    "name": "Rzeszów",           "country": "PL", "lat": 50.0413, "lng": 21.9990, "timezone": "Europe/Warsaw", "currency": "PLN", "addressMarkers": ["Rzeszów", "Rzeszow", "Жешув"]},
    {"code": "torun",      "name": "Toruń",             "country": "PL", "lat": 53.0138, "lng": 18.5984, "timezone": "Europe/Warsaw", "currency": "PLN", "addressMarkers": ["Toruń", "Torun", "Торунь"]},
]


def _infer_city(org: dict) -> Optional[str]:
    """Derive city code for an org based on address substring or proximity to a known centre."""
    address = (org.get("address") or "").lower()
    for c in CITY_CATALOGUE:
        for marker in c["addressMarkers"]:
            if marker.lower() in address:
                return c["code"]
    # fallback: nearest center by lat/lng
    loc = org.get("location") or {}
    coords = loc.get("coordinates") or []
    if len(coords) == 2:
        lng, lat = coords
        nearest = None
        nearest_d = 1e9
        for c in CITY_CATALOGUE:
            d = (c["lat"] - lat) ** 2 + (c["lng"] - lng) ** 2
            if d < nearest_d:
                nearest_d = d
                nearest = c["code"]
        return nearest
    return None


async def _ensure_city_field() -> None:
    """One-shot migration: tag every org with a `city` if missing."""
    cursor = db.organizations.find({"$or": [{"city": None}, {"city": {"$exists": False}}]}, {"_id": 1, "address": 1, "location": 1})
    async for doc in cursor:
        code = _infer_city(doc)
        if code:
            await db.organizations.update_one({"_id": doc["_id"]}, {"$set": {"city": code}})


@router.get("/api/cities", response_model=List[City])
async def list_cities(_=Depends(rate_limit_public)):
    """List supported cities with provider counts."""
    await _ensure_city_field()

    # Aggregate counts per city in one round-trip
    counts = {}
    pipeline = [{"$match": {"status": "active"}}, {"$group": {"_id": "$city", "n": {"$sum": 1}}}]
    async for r in db.organizations.aggregate(pipeline):
        if r["_id"]:
            counts[r["_id"]] = r["n"]

    return [
        City(
            code=c["code"], name=c["name"], country=c["country"],
            lat=c["lat"], lng=c["lng"], timezone=c["timezone"],
            currency=c["currency"], providersCount=counts.get(c["code"], 0),
            aliases=c.get("addressMarkers", []),
        )
        for c in CITY_CATALOGUE
    ]


@router.get("/api/cities/{code}", response_model=City)
async def get_city(code: str, _=Depends(rate_limit_public)):
    await _ensure_city_field()
    c = next((x for x in CITY_CATALOGUE if x["code"] == code), None)
    if not c:
        from fastapi import HTTPException
        raise HTTPException(404, f"city '{code}' not found")
    n = await db.organizations.count_documents({"status": "active", "city": code})
    return City(
        code=c["code"], name=c["name"], country=c["country"],
        lat=c["lat"], lng=c["lng"], timezone=c["timezone"],
        currency=c["currency"], providersCount=n,
        aliases=c.get("addressMarkers", []),
    )
