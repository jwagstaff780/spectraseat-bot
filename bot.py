import os
import logging
import asyncio
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Set, Optional, Tuple

import httpx
from telegram import (
    Update,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
)
from telegram.ext import (
    ApplicationBuilder,
    CommandHandler,
    CallbackQueryHandler,
    ContextTypes,
)

# ======================================================
# Logging
# ======================================================

logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    level=logging.INFO,
)
logger = logging.getLogger(__name__)

# ======================================================
# Environment
# ======================================================

BOT_TOKEN = os.environ["BOT_TOKEN"]

# Ticketmaster – support either env var name
TM_API_KEY = os.environ.get("TM_API_KEY") or os.environ.get("TICKETMASTER_API_KEY")

# Skiddle API key
SKIDDLE_API_KEY = os.environ.get("SKIDDLE_API_KEY")

# Optional: admin chat ID for startup notification (string)
ADMIN_CHAT_ID = os.environ.get("ADMIN_CHAT_ID")

# ======================================================
# In-memory state
# ======================================================

KNOWN_USERS: Set[int] = set()          # chat IDs that did /start
ALERTED_EVENT_IDS: Set[str] = set()    # event IDs we already alerted on (per process)
LAST_SCAN_TIME: Optional[datetime] = None
LAST_SCAN_COUNT: int = 0

RADAR_LOOP_STARTED: bool = False

# Gold Market weekend monitor state
GOLD_MARKET_ALERTED_IDS: Set[str] = set()
GOLD_MARKET_LAST_SCAN: Optional[datetime] = None
GOLD_MARKET_LOOP_STARTED: bool = False

# Provider toggles (can be changed via HUD)
PROVIDER_CONFIG = {
    "tm_music": True,
    "tm_boxing": True,
    "skiddle": True,
}

# Radar config
MONEY_MAKER_THRESHOLD = 60.0  # trade_score threshold for alerts (slightly aggressive)
RADAR_INTERVAL_SECONDS = 300  # 5 minutes

# Gold Market weekend monitor config
GOLD_MARKET_KEYWORDS = ["Gold Market"]
GOLD_MARKET_WEEKEND_INTERVAL_SECONDS = 60   # scan every minute on weekends
GOLD_MARKET_WEEKDAY_INTERVAL_SECONDS = 600  # scan every 10 min on weekdays

# Radar focus – internal lists
TRENDING_ARTISTS = [
    "Central Cee",
    "Drake",
    "Taylor Swift",
    "Fred again",
    "WHP",
    "Warehouse Project",
    "Mint Festival",
    "Parklife",
    "Wireless",
    "Reading Festival",
    "Leeds Festival",
    "Creamfields",
    "Burna Boy",
    "Ayra Starr",
]

# Big boxing / combat sports names & keywords
TRENDING_FIGHTERS = [
    "Jake Paul",
    "Anthony Joshua",
    "Tyson Fury",
    "KSI",
    "UFC",
    "Matchroom Boxing",
    "Misfits Boxing",
    "Fight Night",
]

UK_CITIES = [
    "London",
    "Manchester",
    "Leeds",
    "Birmingham",
    "Liverpool",
    "Glasgow",
    "Edinburgh",
    "Bristol",
    "Newcastle",
]


# ======================================================
# Model
# ======================================================

@dataclass
class Opportunity:
    event_id: str
    name: str
    city: str
    venue: str
    date_str: str
    source: str          # e.g. "TM-Music", "TM-Boxing", "Skiddle"
    primary_min: float
    primary_max: float
    demand_score: float  # 0-100
    risk_score: float    # 0-100
    url: Optional[str] = None
    tags: Optional[List[str]] = None

    @property
    def margin_pct_guess(self) -> float:
        # Simple proxy: cheaper tickets + high demand => higher % margin
        if self.primary_min <= 0:
            base = 12.0  # assume pre-sale / not fully priced yet
        else:
            base = 10.0

        cheap_boost = 10.0 if self.primary_min > 0 and self.primary_min <= 80 else 0.0
        demand_boost = (self.demand_score - 50) * 0.4
        return max(0.0, base + cheap_boost + demand_boost)

    @property
    def trade_score(self) -> float:
        # demand + margin guess – risk
        return self.demand_score + self.margin_pct_guess - self.risk_score


# ======================================================
# Ticketmaster helpers (Discovery API)
# ======================================================

async def _tm_get_events(params: Dict) -> List[Dict]:
    """Low-level helper to call Ticketmaster Discovery API."""
    if not TM_API_KEY:
        logger.warning("No TM_API_KEY / TICKETMASTER_API_KEY set; skipping Ticketmaster.")
        return []

    base_params = {
        "apikey": TM_API_KEY,
        "countryCode": "GB",   # UK only
        "size": 100,
        "sort": "date,asc",
        "locale": "*",
    }
    base_params.update(params)

    url = "https://app.ticketmaster.com/discovery/v2/events.json"

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(url, params=base_params)
            resp.raise_for_status()
            data = resp.json()
    except Exception as e:
        logger.warning("Ticketmaster request failed: %s", e)
        return []

    return data.get("_embedded", {}).get("events", [])


def _parse_price(ev: Dict) -> Tuple[float, float]:
    """Extract min/max price if present."""
    primary_min = 0.0
    primary_max = 0.0
    for pr in ev.get("priceRanges", []):
        try:
            mn = float(pr.get("min"))
            mx = float(pr.get("max"))
        except Exception:
            continue
        if primary_min == 0.0 or mn < primary_min:
            primary_min = mn
        if mx > primary_max:
            primary_max = mx
    return primary_min, primary_max


def _parse_basic_event_fields(ev: Dict) -> Dict:
    """Normalize name, city, venue, date."""
    name = ev.get("name") or "Unknown Event"
    venue = "Unknown venue"
    city = "Unknown"
    try:
        v = (ev.get("_embedded", {}).get("venues") or [])[0]
        venue = v.get("name") or venue
        city = (v.get("city") or {}).get("name") or city
    except Exception:
        pass

    start_info = (ev.get("dates") or {}).get("start") or {}
    dt_raw = start_info.get("dateTime") or start_info.get("localDate")
    date_str = dt_raw or "Unknown date"
    if dt_raw:
        try:
            if "T" in dt_raw:
                dt = datetime.fromisoformat(dt_raw.replace("Z", "+00:00"))
            else:
                dt = datetime.fromisoformat(dt_raw + "T00:00:00+00:00")
            date_str = dt.strftime("%d %b %Y")
        except Exception:
            pass

    return {
        "name": name,
        "venue": venue,
        "city": city,
        "date_str": date_str,
    }


# ======================================================
# Providers: Ticketmaster music + boxing
# ======================================================

async def fetch_tm_music_hot() -> List[Opportunity]:
    """Fetch hot UK music/festival events likely to be money-makers."""
    if not TM_API_KEY or not PROVIDER_CONFIG.get("tm_music", True):
        return []

    now = datetime.now(timezone.utc)
    params = {
        "classificationName": "music",
        "startDateTime": now.isoformat(timespec="seconds").replace("+00:00", "Z"),
        "endDateTime": (now + timedelta(days=90)).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "keyword": " ".join(TRENDING_ARTISTS),
    }

    events = await _tm_get_events(params)
    out: List[Opportunity] = []

    for ev in events:
        base = _parse_basic_event_fields(ev)
        event_id = ev.get("id") or base["name"]

        primary_min, primary_max = _parse_price(ev)

        # Demand scoring
        name_lower = base["name"].lower()
        demand_score = 55.0

        # Boost if UK city of interest
        if any(c.lower() == base["city"].lower() for c in UK_CITIES):
            demand_score += 10.0

        # Boost if trending artist / brand mentioned
        for artist in TRENDING_ARTISTS:
            if artist.lower() in name_lower:
                demand_score += 25.0
                break

        # Boost if relatively affordable
        if primary_min > 0 and primary_min <= 80:
            demand_score += 10.0

        # Risk – festivals & club shows moderate risk
        risk_score = 20.0

        tags: List[str] = ["music"]
        if "festival" in name_lower:
            tags.append("festival")
        if primary_min > 0 and primary_min <= 60:
            tags.append("cheap-entry")
        if demand_score >= 80:
            tags.append("hype")

        opp = Opportunity(
            event_id=event_id,
            name=base["name"],
            city=base["city"],
            venue=base["venue"],
            date_str=base["date_str"],
            source="TM-Music",
            primary_min=primary_min,
            primary_max=primary_max,
            demand_score=demand_score,
            risk_score=risk_score,
            url=ev.get("url"),
            tags=tags,
        )
        out.append(opp)

    return out


async def fetch_tm_boxing_hot() -> List[Opportunity]:
    """Fetch big boxing / fight-night style events (Jake Paul, AJ, etc.)."""
    if not TM_API_KEY or not PROVIDER_CONFIG.get("tm_boxing", True):
        return []

    now = datetime.now(timezone.utc)
    params = {
        "classificationName": "sports",
        "startDateTime": now.isoformat(timespec="seconds").replace("+00:00", "Z"),
        "endDateTime": (now + timedelta(days=120)).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "keyword": " ".join(TRENDING_FIGHTERS),
    }

    events = await _tm_get_events(params)
    out: List[Opportunity] = []

    for ev in events:
        base = _parse_basic_event_fields(ev)
        event_id = ev.get("id") or base["name"]

        primary_min, primary_max = _parse_price(ev)
        name_lower = base["name"].lower()

        demand_score = 60.0

        # Heavy boost if it’s clearly a big-name fight
        for fighter in TRENDING_FIGHTERS:
            if fighter.lower() in name_lower:
                demand_score += 30.0
                break

        # Boxing is higher risk (injury, cancellations, undercards)
        risk_score = 28.0

        tags: List[str] = ["boxing"]
        if "jake paul" in name_lower or "ksi" in name_lower:
            tags.append("crossover")
        if "anthony joshua" in name_lower or "tyson fury" in name_lower or "ufc" in name_lower:
            tags.append("elite")
        if primary_min > 0 and primary_min <= 120:
            demand_score += 10.0
            tags.append("affordable-entry")

        opp = Opportunity(
            event_id=event_id,
            name=base["name"],
            city=base["city"],
            venue=base["venue"],
            date_str=base["date_str"],
            source="TM-Boxing",
            primary_min=primary_min,
            primary_max=primary_max,
            demand_score=demand_score,
            risk_score=risk_score,
            url=ev.get("url"),
            tags=tags,
        )
        out.append(opp)

    return out


# ======================================================
# Provider: Skiddle UK
# ======================================================

async def fetch_skiddle_hot() -> List[Opportunity]:
    """
    Fetch hot UK events from Skiddle API.
    Focus: raves, club nights, festivals, live music in UK cities.
    """
    if not SKIDDLE_API_KEY or not PROVIDER_CONFIG.get("skiddle", True):
        return []

    url = "https://www.skiddle.com/api/v1/events/"
    params = {
        "api_key": SKIDDLE_API_KEY,
        "country": "UK",
        "limit": 100,
        "order": "date",
    }

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(url, params=params)
            resp.raise_for_status()
            data = resp.json()
    except Exception as e:
        logger.warning("Skiddle request failed: %s", e)
        return []

    results = data.get("results", [])
    out: List[Opportunity] = []

    for ev in results:
        name = ev.get("eventname") or "Unknown Skiddle Event"
        town = ev.get("town") or ev.get("venue", "") or "Unknown"
        venue_name = ev.get("venue", "") or "Unknown venue"
        date_raw = ev.get("date") or ""
        date_str = date_raw
        try:
            dt = datetime.strptime(date_raw, "%Y-%m-%d")
            date_str = dt.strftime("%d %b %Y")
        except Exception:
            pass

        # price
        primary_min = 0.0
        primary_max = 0.0
        try:
            if ev.get("minprice"):
                primary_min = float(ev["minprice"])
            if ev.get("maxprice"):
                primary_max = float(ev["maxprice"])
        except Exception:
            pass

        name_lower = name.lower()
        demand_score = 55.0

        # Boost if in one of our UK target cities
        if any(c.lower() in town.lower() for c in UK_CITIES):
            demand_score += 10.0

        # Boost if trending artist/brand appears in eventname
        for artist in TRENDING_ARTISTS:
            if artist.lower() in name_lower:
                demand_score += 25.0
                break

        # Boost for cheap entry (classic rave/flipper territory)
        if primary_min > 0 and primary_min <= 35:
            demand_score += 10.0

        # Risk is slightly higher than TM music due to club cancellations, etc.
        risk_score = 20.0

        tags: List[str] = ["Skiddle"]
        if "festival" in name_lower:
            tags.append("festival")
        if primary_min > 0 and primary_min <= 25:
            tags.append("cheap-entry")
        if demand_score >= 80:
            tags.append("hype")

        event_id = str(ev.get("id") or name)
        link = ev.get("link")

        opp = Opportunity(
            event_id=event_id,
            name=name,
            city=town,
            venue=venue_name,
            date_str=date_str,
            source="Skiddle",
            primary_min=primary_min,
            primary_max=primary_max,
            demand_score=demand_score,
            risk_score=risk_score,
            url=link,
            tags=tags,
        )
        out.append(opp)

    return out


# ======================================================
# Gold Market dedicated fetcher
# ======================================================

def _is_weekend_utc() -> bool:
    """Return True if today is Saturday (5) or Sunday (6) in UTC."""
    return datetime.now(timezone.utc).weekday() >= 5


async def fetch_gold_market_events() -> List[Opportunity]:
    """
    Search Ticketmaster and Skiddle specifically for Gold Market events.
    Runs on a tight loop over weekends to catch new listings fast.
    """
    opps: List[Opportunity] = []

    # --- Ticketmaster ---
    if TM_API_KEY:
        now = datetime.now(timezone.utc)
        params = {
            "keyword": "Gold Market",
            "startDateTime": now.isoformat(timespec="seconds").replace("+00:00", "Z"),
            "endDateTime": (now + timedelta(days=180)).isoformat(timespec="seconds").replace("+00:00", "Z"),
        }
        events = await _tm_get_events(params)
        for ev in events:
            base = _parse_basic_event_fields(ev)
            event_id = "gm_tm_" + (ev.get("id") or base["name"])
            primary_min, primary_max = _parse_price(ev)
            name_lower = base["name"].lower()

            demand_score = 70.0
            if any(c.lower() == base["city"].lower() for c in UK_CITIES):
                demand_score += 10.0
            if primary_min > 0 and primary_min <= 100:
                demand_score += 10.0

            tags = ["gold-market", "TM"]
            if "festival" in name_lower:
                tags.append("festival")
            if demand_score >= 80:
                tags.append("hype")

            opps.append(Opportunity(
                event_id=event_id,
                name=base["name"],
                city=base["city"],
                venue=base["venue"],
                date_str=base["date_str"],
                source="TM-GoldMarket",
                primary_min=primary_min,
                primary_max=primary_max,
                demand_score=demand_score,
                risk_score=18.0,
                url=ev.get("url"),
                tags=tags,
            ))

    # --- Skiddle ---
    if SKIDDLE_API_KEY:
        url = "https://www.skiddle.com/api/v1/events/"
        params = {
            "api_key": SKIDDLE_API_KEY,
            "keyword": "Gold Market",
            "country": "UK",
            "limit": 50,
            "order": "date",
        }
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.get(url, params=params)
                resp.raise_for_status()
                data = resp.json()
            for ev in data.get("results", []):
                name = ev.get("eventname") or "Gold Market Event"
                name_lower = name.lower()
                if "gold market" not in name_lower:
                    continue  # only exact matches from keyword-less Skiddle responses

                town = ev.get("town") or "Unknown"
                venue_name = ev.get("venue") or "Unknown venue"
                date_raw = ev.get("date") or ""
                date_str = date_raw
                try:
                    dt = datetime.strptime(date_raw, "%Y-%m-%d")
                    date_str = dt.strftime("%d %b %Y")
                except Exception:
                    pass

                primary_min = 0.0
                primary_max = 0.0
                try:
                    if ev.get("minprice"):
                        primary_min = float(ev["minprice"])
                    if ev.get("maxprice"):
                        primary_max = float(ev["maxprice"])
                except Exception:
                    pass

                demand_score = 70.0
                if any(c.lower() in town.lower() for c in UK_CITIES):
                    demand_score += 10.0
                if primary_min > 0 and primary_min <= 35:
                    demand_score += 10.0

                tags = ["gold-market", "Skiddle"]
                if demand_score >= 80:
                    tags.append("hype")

                event_id = "gm_sk_" + str(ev.get("id") or name)
                opps.append(Opportunity(
                    event_id=event_id,
                    name=name,
                    city=town,
                    venue=venue_name,
                    date_str=date_str,
                    source="Skiddle-GoldMarket",
                    primary_min=primary_min,
                    primary_max=primary_max,
                    demand_score=demand_score,
                    risk_score=18.0,
                    url=ev.get("link"),
                    tags=tags,
                ))
        except Exception as e:
            logger.warning("Gold Market Skiddle fetch failed: %s", e)

    opps.sort(key=lambda o: o.trade_score, reverse=True)
    logger.info("Gold Market fetch complete: %d events.", len(opps))
    return opps


async def gold_market_weekend_loop(app):
    """
    Background task dedicated to Gold Market monitoring.
    Runs every minute on weekends, every 10 min on weekdays.
    Pushes alerts for any new Gold Market listings not yet seen.
    """
    global GOLD_MARKET_ALERTED_IDS, GOLD_MARKET_LAST_SCAN, GOLD_MARKET_LOOP_STARTED
    GOLD_MARKET_LOOP_STARTED = True
    logger.info("Gold Market weekend monitor started.")

    while True:
        interval = (
            GOLD_MARKET_WEEKEND_INTERVAL_SECONDS
            if _is_weekend_utc()
            else GOLD_MARKET_WEEKDAY_INTERVAL_SECONDS
        )
        try:
            if KNOWN_USERS:
                opps = await fetch_gold_market_events()
                GOLD_MARKET_LAST_SCAN = datetime.now(timezone.utc)

                new_opps = [o for o in opps if o.event_id not in GOLD_MARKET_ALERTED_IDS]
                if new_opps:
                    new_opps = new_opps[:5]
                    for o in new_opps:
                        GOLD_MARKET_ALERTED_IDS.add(o.event_id)

                    weekend_tag = " [WEEKEND MONITOR]" if _is_weekend_utc() else ""
                    logger.info(
                        "Gold Market%s: pushing %d new listings to %d users.",
                        weekend_tag, len(new_opps), len(KNOWN_USERS),
                    )

                    for user_id in list(KNOWN_USERS):
                        for opp in new_opps:
                            price_line = "Price: unknown"
                            if opp.primary_min > 0 and opp.primary_max > 0:
                                price_line = f"Price: £{opp.primary_min:.0f}–£{opp.primary_max:.0f}"
                            elif opp.primary_min > 0:
                                price_line = f"From: £{opp.primary_min:.0f}"

                            tags_str = ""
                            if opp.tags:
                                tags_str = " | " + ", ".join(opp.tags)

                            header = (
                                "🟡 Gold Market weekend hit!"
                                if _is_weekend_utc()
                                else "🟡 Gold Market new listing"
                            )
                            lines = [
                                f"{header} ({opp.source})",
                                "",
                                opp.name,
                                f"{opp.venue} – {opp.city} – {opp.date_str}",
                                price_line,
                                (
                                    f"Demand: {opp.demand_score:.1f} | "
                                    f"Margin guess: {opp.margin_pct_guess:.1f}% | "
                                    f"Risk: {opp.risk_score:.1f}"
                                ),
                                f"Trade score: {opp.trade_score:.1f}{tags_str}",
                            ]
                            if opp.url:
                                lines += ["", f"Listing: {opp.url}"]

                            try:
                                await app.bot.send_message(
                                    chat_id=user_id,
                                    text="\n".join(lines),
                                    disable_web_page_preview=False,
                                )
                            except Exception as e:
                                logger.warning(
                                    "Failed to send Gold Market alert to %s: %s", user_id, e
                                )
        except Exception as e:
            logger.exception("Error in gold_market_weekend_loop: %s", e)

        await asyncio.sleep(interval)


# ======================================================
# Radar scan
# ======================================================

async def run_radar_scan() -> List[Opportunity]:
    """Pull hot music + boxing + Skiddle events and return sorted opportunities."""
    logger.info("Running radar scan (Ticketmaster + Skiddle)…")
    music, boxing, skiddle = await asyncio.gather(
        fetch_tm_music_hot(),
        fetch_tm_boxing_hot(),
        fetch_skiddle_hot(),
    )
    all_opps = music + boxing + skiddle
    all_opps.sort(key=lambda o: o.trade_score, reverse=True)
    logger.info("Radar scan complete: %d opportunities.", len(all_opps))
    return all_opps


# ======================================================
# Background radar loop (NO JobQueue)
# ======================================================

async def radar_auto_loop(app):
    """
    Background task that runs forever, every RADAR_INTERVAL_SECONDS.
    Uses app.bot.send_message directly (no JobQueue).
    """
    global LAST_SCAN_TIME, LAST_SCAN_COUNT, ALERTED_EVENT_IDS, RADAR_LOOP_STARTED
    RADAR_LOOP_STARTED = True
    logger.info("Radar auto-loop started (interval=%ds).", RADAR_INTERVAL_SECONDS)

    while True:
        try:
            if not KNOWN_USERS:
                # Nobody to notify yet
                await asyncio.sleep(60)
                continue

            logger.info("Auto radar scan tick – scanning Ticketmaster + Skiddle…")
            opps = await run_radar_scan()
            LAST_SCAN_TIME = datetime.now(timezone.utc)
            LAST_SCAN_COUNT = len(opps)

            # Filter to “money maker” grade
            hot_opps = [o for o in opps if o.trade_score >= MONEY_MAKER_THRESHOLD]

            # Avoid re-alerting the same events in this process lifetime
            new_hot = [o for o in hot_opps if o.event_id not in ALERTED_EVENT_IDS]

            if not new_hot:
                logger.info("No NEW hot events above threshold this round.")
            else:
                # Cap alerts per scan
                new_hot = new_hot[:5]

                # Record them as alerted
                for o in new_hot:
                    ALERTED_EVENT_IDS.add(o.event_id)

                logger.info(
                    "Pushing %d new hot events to %d users.",
                    len(new_hot),
                    len(KNOWN_USERS),
                )

                # Push alerts to all known users
                for user_id in list(KNOWN_USERS):
                    for opp in new_hot:
                        tags_str = ""
                        if opp.tags:
                            tags_str = " | " + ", ".join(opp.tags)

                        price_line = "Price: unknown"
                        if opp.primary_min > 0 and opp.primary_max > 0:
                            price_line = (
                                f"Price: £{opp.primary_min:.0f}–£{opp.primary_max:.0f}"
                            )
                        elif opp.primary_min > 0:
                            price_line = f"From: £{opp.primary_min:.0f}"

                        lines = [
                            f"🚨 Money-maker radar hit ({opp.source})",
                            "",
                            f"{opp.name}",
                            f"{opp.venue} – {opp.city} – {opp.date_str}",
                            price_line,
                            (
                                f"Demand: {opp.demand_score:.1f} | "
                                f"Margin guess: {opp.margin_pct_guess:.1f}% | "
                                f"Risk: {opp.risk_score:.1f}"
                            ),
                            f"Trade score: {opp.trade_score:.1f}{tags_str}",
                        ]
                        if opp.url:
                            lines.append("")
                            lines.append(f"Listing: {opp.url}")

                        text = "\n".join(lines)

                        try:
                            await app.bot.send_message(
                                chat_id=user_id,
                                text=text,
                                disable_web_page_preview=False,
                            )
                        except Exception as e:
                            logger.warning(
                                "Failed to send alert to %s: %s", user_id, e
                            )

        except Exception as e:
            logger.exception("Error in radar_auto_loop: %s", e)

        await asyncio.sleep(RADAR_INTERVAL_SECONDS)


async def on_startup(app):
    """Called once the Application is ready; start the radar loop + optional admin notify."""
    logger.info("on_startup() called – creating radar_auto_loop task.")
    app.create_task(radar_auto_loop(app))
    app.create_task(gold_market_weekend_loop(app))

    if ADMIN_CHAT_ID:
        try:
            weekend_interval = GOLD_MARKET_WEEKEND_INTERVAL_SECONDS
            weekday_interval = GOLD_MARKET_WEEKDAY_INTERVAL_SECONDS
            text = (
                "SpectraSeat radar bot started.\n\n"
                f"Providers:\n"
                f"- Ticketmaster: {'ON' if TM_API_KEY else 'OFF'}\n"
                f"- Skiddle: {'ON' if SKIDDLE_API_KEY else 'OFF'}\n\n"
                f"Auto radar every {RADAR_INTERVAL_SECONDS // 60} min, "
                f"threshold trade_score ≥ {MONEY_MAKER_THRESHOLD:.0f}.\n\n"
                f"🟡 Gold Market monitor: every {weekend_interval}s on weekends, "
                f"every {weekday_interval // 60} min on weekdays."
            )
            await app.bot.send_message(chat_id=int(ADMIN_CHAT_ID), text=text)
        except Exception as e:
            logger.warning("Failed to send startup notify to ADMIN_CHAT_ID: %s", e)


# ======================================================
# HUD builders
# ======================================================

def build_providers_status_lines() -> List[str]:
    tm_music_status = "⚠️ OFF"
    if TM_API_KEY and PROVIDER_CONFIG.get("tm_music", True):
        tm_music_status = "🎧 ON (music)"
    elif TM_API_KEY:
        tm_music_status = "⏸ Music OFF (API OK)"

    tm_box_status = "⚠️ OFF"
    if TM_API_KEY and PROVIDER_CONFIG.get("tm_boxing", True):
        tm_box_status = "🥊 ON (boxing)"
    elif TM_API_KEY:
        tm_box_status = "⏸ Boxing OFF (API OK)"

    sk_status = "⚠️ OFF"
    if SKIDDLE_API_KEY and PROVIDER_CONFIG.get("skiddle", True):
        sk_status = "🎛 ON"
    elif SKIDDLE_API_KEY:
        sk_status = "⏸ OFF (API OK)"

    return [
        f"- Ticketmaster (music): {tm_music_status}",
        f"- Ticketmaster (boxing): {tm_box_status}",
        f"- Skiddle: {sk_status}",
    ]


def build_hud_main_text() -> str:
    if LAST_SCAN_TIME is None:
        last_scan_line = "Last scan: not run yet"
    else:
        when = LAST_SCAN_TIME.astimezone(timezone.utc).strftime("%d %b %Y %H:%M UTC")
        last_scan_line = (
            f"Last scan: {when} – {LAST_SCAN_COUNT} events evaluated"
        )

    radar_status = "✅ Running" if RADAR_LOOP_STARTED else "⚠️ Not started yet"

    heat = "🟢 calm"
    if LAST_SCAN_COUNT >= 200:
        heat = "🔥 heavy action"
    elif LAST_SCAN_COUNT >= 100:
        heat = "🟠 warm"

    providers_lines = build_providers_status_lines()

    gm_status = "✅ Running" if GOLD_MARKET_LOOP_STARTED else "⚠️ Not started yet"
    gm_interval = (
        f"{GOLD_MARKET_WEEKEND_INTERVAL_SECONDS}s (weekend mode)"
        if _is_weekend_utc()
        else f"{GOLD_MARKET_WEEKDAY_INTERVAL_SECONDS // 60} min (weekday mode)"
    )
    gm_last = (
        GOLD_MARKET_LAST_SCAN.strftime("%H:%M UTC")
        if GOLD_MARKET_LAST_SCAN
        else "not yet"
    )

    lines = [
        "🧠 SpectraSeat Radar HUD",
        "",
        "📡 System",
        f"- Radar loop: {radar_status}",
        f"- Interval: {RADAR_INTERVAL_SECONDS // 60} min",
        f"- Money-maker threshold: trade_score ≥ {MONEY_MAKER_THRESHOLD:.0f}",
        "",
        "📈 Market activity",
        last_scan_line,
        f"Heat: {heat}",
        "",
        "🟡 Gold Market Monitor",
        f"- Status: {gm_status}",
        f"- Scan interval: {gm_interval}",
        f"- Last scan: {gm_last}",
        f"- New listings alerted: {len(GOLD_MARKET_ALERTED_IDS)}",
        "",
        "👤 Users",
        f"- Known users: {len(KNOWN_USERS)}",
        f"- Unique hot events alerted (this run): {len(ALERTED_EVENT_IDS)}",
        "",
        "🎛 Providers",
        *providers_lines,
        "",
        "Use the buttons below to refresh, see hot events, or trigger a scan.",
    ]
    return "\n".join(lines)


def build_hud_providers_text() -> str:
    providers_lines = build_providers_status_lines()
    lines = [
        "🎛 Provider Control",
        "",
        *providers_lines,
        "",
        "Tap buttons to toggle providers on/off.\n"
        "Note: if an API key is missing, that provider stays effectively OFF.",
    ]
    return "\n".join(lines)


def build_hud_hot_text(opps: List[Opportunity]) -> str:
    if not opps:
        return "🔥 Hot Events\n\nNo opportunities found right now. Try /scan later."

    top = opps[:7]
    lines = ["🔥 Hot Events Snapshot", ""]
    for opp in top:
        tags_str = ""
        if opp.tags:
            tags_str = " | " + ", ".join(opp.tags)

        price_line = "Price: unknown"
        if opp.primary_min > 0 and opp.primary_max > 0:
            price_line = f"Price: £{opp.primary_min:.0f}–£{opp.primary_max:.0f}"
        elif opp.primary_min > 0:
            price_line = f"From: £{opp.primary_min:.0f}"

        lines.append(
            f"{opp.name} ({opp.source})\n"
            f"{opp.venue} – {opp.city} – {opp.date_str}\n"
            f"{price_line}\n"
            f"Demand: {opp.demand_score:.1f} | Margin guess: {opp.margin_pct_guess:.1f}% | "
            f"Risk: {opp.risk_score:.1f}\n"
            f"Trade score: {opp.trade_score:.1f}{tags_str}\n"
            f"{opp.url or ''}\n"
        )
    return "\n".join(lines)


def build_hud_main_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        [
            [
                InlineKeyboardButton("📊 Dashboard", callback_data="hud_main"),
                InlineKeyboardButton("🔥 Hot Now", callback_data="hud_hot"),
            ],
            [
                InlineKeyboardButton("🎛 Providers", callback_data="hud_providers"),
                InlineKeyboardButton("♻️ Refresh", callback_data="hud_refresh"),
            ],
            [
                InlineKeyboardButton("📡 Force Scan", callback_data="hud_scan"),
                InlineKeyboardButton("🟡 Gold Market", callback_data="hud_goldmarket"),
            ],
        ]
    )


def build_hud_providers_keyboard() -> InlineKeyboardMarkup:
    def label(flag: bool, name: str) -> str:
        return f"{'✅' if flag else '❌'} {name}"

    return InlineKeyboardMarkup(
        [
            [
                InlineKeyboardButton(
                    label(PROVIDER_CONFIG.get("tm_music", True), "TM Music"),
                    callback_data="hud_toggle_tm_music",
                ),
            ],
            [
                InlineKeyboardButton(
                    label(PROVIDER_CONFIG.get("tm_boxing", True), "TM Boxing"),
                    callback_data="hud_toggle_tm_boxing",
                ),
            ],
            [
                InlineKeyboardButton(
                    label(PROVIDER_CONFIG.get("skiddle", True), "Skiddle"),
                    callback_data="hud_toggle_skiddle",
                ),
            ],
            [
                InlineKeyboardButton("⬅️ Back", callback_data="hud_main"),
            ],
        ]
    )


# ======================================================
# Commands
# ======================================================

async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    KNOWN_USERS.add(user_id)
    logger.info("User %s called /start. KNOWN_USERS=%d", user_id, len(KNOWN_USERS))

    text = (
        "✅ SpectraSeat radar online.\n\n"
        "I automatically scan UK Ticketmaster (music + boxing) and Skiddle for "
        "hot events – festivals, arena shows, boxing cards, raves.\n\n"
        "Every few minutes I:\n"
        "- Pull fresh UK events (Ticketmaster + Skiddle)\n"
        "- Score them for demand / margin / risk\n"
        "- DM you when something crosses the money-maker threshold.\n\n"
        "Commands:\n"
        "- /hud – full radar HUD (dashboard + buttons)\n"
        "- /status – quick status of last scan\n"
        "- /scan – force a manual radar scan now\n"
        "- /goldmarket – Gold Market listings (TM + Skiddle)\n"
        "- /ping – simple health check\n"
        "- /ukhot – shortcut to /scan\n"
    )
    await update.message.reply_text(text)


async def cmd_ping(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text("🏓 Pong – radar is alive.")


async def cmd_status(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    KNOWN_USERS.add(user_id)

    if LAST_SCAN_TIME is None:
        await update.message.reply_text(
            "I haven’t completed a radar scan yet. Use /scan to trigger one."
        )
        return

    when = LAST_SCAN_TIME.astimezone(timezone.utc).strftime("%d %b %Y %H:%M UTC")
    msg = (
        f"📊 Last radar scan: {when}\n"
        f"Events evaluated: {LAST_SCAN_COUNT}\n"
        f"Alerted events this session: {len(ALERTED_EVENT_IDS)}\n"
        f"Known users: {len(KNOWN_USERS)}"
    )
    await update.message.reply_text(msg)


async def cmd_scan(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Manual radar scan for when you want an instant snapshot."""
    user_id = update.effective_user.id
    KNOWN_USERS.add(user_id)
    logger.info("User %s requested manual /scan", user_id)

    msg = await update.message.reply_text("📡 Running radar scan now…")

    opps = await run_radar_scan()
    if not opps:
        await msg.edit_text(
            "I couldn’t pull any events just now.\n\n"
            "Check that TM_API_KEY / SKIDDLE_API_KEY are set in Render, "
            "and try again later."
        )
        return

    text = build_hud_hot_text(opps)
    await msg.edit_text(text, disable_web_page_preview=False)


async def cmd_hud(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Send the main HUD dashboard with buttons."""
    user_id = update.effective_user.id
    KNOWN_USERS.add(user_id)

    text = build_hud_main_text()
    keyboard = build_hud_main_keyboard()
    await update.message.reply_text(
        text,
        disable_web_page_preview=True,
        reply_markup=keyboard,
    )


async def cmd_goldmarket(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Manual Gold Market scan – shows current listings from TM + Skiddle."""
    user_id = update.effective_user.id
    KNOWN_USERS.add(user_id)
    logger.info("User %s requested /goldmarket scan", user_id)

    weekend_label = "🟡 Weekend mode ON" if _is_weekend_utc() else "⚪ Weekday mode"
    msg = await update.message.reply_text(
        f"🔍 Scanning for Gold Market events… ({weekend_label})"
    )

    opps = await fetch_gold_market_events()

    if not opps:
        await msg.edit_text(
            "No Gold Market events found right now.\n\n"
            "Check that TM_API_KEY / SKIDDLE_API_KEY are set and try again later."
        )
        return

    lines = [f"🟡 Gold Market Events ({weekend_label})", ""]
    for opp in opps[:7]:
        price_line = "Price: unknown"
        if opp.primary_min > 0 and opp.primary_max > 0:
            price_line = f"Price: £{opp.primary_min:.0f}–£{opp.primary_max:.0f}"
        elif opp.primary_min > 0:
            price_line = f"From: £{opp.primary_min:.0f}"

        tags_str = " | " + ", ".join(opp.tags) if opp.tags else ""
        lines.append(
            f"{opp.name} ({opp.source})\n"
            f"{opp.venue} – {opp.city} – {opp.date_str}\n"
            f"{price_line}\n"
            f"Demand: {opp.demand_score:.1f} | Trade score: {opp.trade_score:.1f}{tags_str}\n"
            f"{opp.url or ''}\n"
        )

    await msg.edit_text("\n".join(lines), disable_web_page_preview=False)


# ======================================================
# HUD callback handler
# ======================================================

async def hud_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    data = query.data

    if data in ("hud_main", "hud_refresh"):
        text = build_hud_main_text()
        keyboard = build_hud_main_keyboard()
        await query.edit_message_text(
            text=text,
            disable_web_page_preview=True,
            reply_markup=keyboard,
        )
        return

    if data == "hud_providers":
        text = build_hud_providers_text()
        keyboard = build_hud_providers_keyboard()
        await query.edit_message_text(
            text=text,
            disable_web_page_preview=True,
            reply_markup=keyboard,
        )
        return

    if data == "hud_hot":
        opps = await run_radar_scan()
        text = build_hud_hot_text(opps)
        keyboard = build_hud_main_keyboard()
        await query.edit_message_text(
            text=text,
            disable_web_page_preview=False,
            reply_markup=keyboard,
        )
        return

    if data == "hud_scan":
        opps = await run_radar_scan()
        text = "📡 Manual radar scan triggered from HUD.\n\n"
        text += build_hud_hot_text(opps)
        keyboard = build_hud_main_keyboard()
        await query.edit_message_text(
            text=text,
            disable_web_page_preview=False,
            reply_markup=keyboard,
        )
        return

    if data == "hud_goldmarket":
        opps = await fetch_gold_market_events()
        weekend_label = "🟡 Weekend mode ON" if _is_weekend_utc() else "⚪ Weekday mode"
        if not opps:
            text = f"🟡 Gold Market ({weekend_label})\n\nNo listings found right now."
        else:
            lines = [f"🟡 Gold Market Events ({weekend_label})", ""]
            for opp in opps[:7]:
                price_line = "Price: unknown"
                if opp.primary_min > 0 and opp.primary_max > 0:
                    price_line = f"Price: £{opp.primary_min:.0f}–£{opp.primary_max:.0f}"
                elif opp.primary_min > 0:
                    price_line = f"From: £{opp.primary_min:.0f}"
                tags_str = " | " + ", ".join(opp.tags) if opp.tags else ""
                lines.append(
                    f"{opp.name} ({opp.source})\n"
                    f"{opp.venue} – {opp.city} – {opp.date_str}\n"
                    f"{price_line}\n"
                    f"Demand: {opp.demand_score:.1f} | Trade score: {opp.trade_score:.1f}{tags_str}\n"
                    f"{opp.url or ''}\n"
                )
            text = "\n".join(lines)
        keyboard = build_hud_main_keyboard()
        await query.edit_message_text(
            text=text,
            disable_web_page_preview=False,
            reply_markup=keyboard,
        )
        return

    # Toggles
    if data == "hud_toggle_tm_music":
        PROVIDER_CONFIG["tm_music"] = not PROVIDER_CONFIG.get("tm_music", True)
    elif data == "hud_toggle_tm_boxing":
        PROVIDER_CONFIG["tm_boxing"] = not PROVIDER_CONFIG.get("tm_boxing", True)
    elif data == "hud_toggle_skiddle":
        PROVIDER_CONFIG["skiddle"] = not PROVIDER_CONFIG.get("skiddle", True)

    if data.startswith("hud_toggle_"):
        # After toggle, re-show providers panel
        text = build_hud_providers_text()
        keyboard = build_hud_providers_keyboard()
        await query.edit_message_text(
            text=text,
            disable_web_page_preview=True,
            reply_markup=keyboard,
        )
        return


# ======================================================
# Main (POLLING, NO WEBHOOK, NO JOBQUEUE)
# ======================================================

def main() -> None:
    logger.info("Starting SpectraSeat autonomous UK radar bot (Ticketmaster + Skiddle)…")

    application = (
        ApplicationBuilder()
        .token(BOT_TOKEN)
        .post_init(on_startup)  # start radar loop after bot connects
        .build()
    )

    # Commands
    application.add_handler(CommandHandler("start", cmd_start))
    application.add_handler(CommandHandler("ping", cmd_ping))
    application.add_handler(CommandHandler("status", cmd_status))
    application.add_handler(CommandHandler("scan", cmd_scan))
    application.add_handler(CommandHandler("ukhot", cmd_scan))
    application.add_handler(CommandHandler("hud", cmd_hud))
    application.add_handler(CommandHandler("goldmarket", cmd_goldmarket))

    # HUD callback
    application.add_handler(CallbackQueryHandler(hud_callback, pattern=r"^hud_"))

    logger.info("Starting polling…")
    application.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()
