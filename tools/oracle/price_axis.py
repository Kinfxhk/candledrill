#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Price-axis decimal check (Python standard library only).

lightweight-charts formats a price with precision = decimal places and
minMove = tick. CandleDrill must pass the tick's own decimal count.
ceil(-log10(tick)) is 1 for tick 0.25, and that formatter prints 4145.75
as 4145.5. This script reimplements that formatter and checks the displayed
string parses back to the price.
"""
import math
import sys


def tick_decimals(tick: float) -> int:
    if not math.isfinite(tick) or tick <= 0:
        raise ValueError(tick)
    for d in range(0, 11):
        scaled = tick * 10**d
        if abs(scaled - round(scaled)) < 1e-9:
            return d
    return 10


def old_log10_precision(tick: float) -> int:
    """The v0.1.1 formula. Wrong whenever the tick has extra digits (0.25, 0.025, 0.125)."""
    return min(10, max(0, math.ceil(-math.log10(tick) - 1e-9)))


def js_number(n: float) -> str:
    if isinstance(n, float) and n.is_integer():
        return str(int(n))
    return str(n)


def pad(value: float, length: int) -> str:
    if length == 0:
        return js_number(value)
    return ("0000000000000000" + js_number(value))[-length:]


def format_price(price: float, precision: int, min_move: float) -> str:
    """Same steps as lightweight-charts 5 PriceFormatter."""
    price_scale = 10**precision
    min_move_i = min_move * price_scale
    frac_len = 0
    base_scale = price_scale
    if price_scale > 0 and min_move_i > 0:
        while base_scale > 1:
            base_scale /= 10
            frac_len += 1
    base = price_scale / min_move_i
    sign = "\u2212" if price < 0 else ""
    price = abs(price)
    int_part = math.floor(price)
    frac_string = ""
    if base > 1:
        frac_part = round(price * base) - int_part * base
        frac_part = float(f"{frac_part:.{frac_len}f}")
        if frac_part >= base:
            frac_part -= base
            int_part += 1
        shown = float(f"{frac_part:.{frac_len}f}") * min_move_i
        frac_string = "." + pad(shown, frac_len)
    else:
        int_part = round(int_part * base) / base
        if frac_len > 0:
            frac_string = "." + pad(0, frac_len)
    return sign + f"{int_part:.0f}" + frac_string


def parses_back(shown: str, price: float) -> bool:
    try:
        return abs(float(shown.replace("\u2212", "-")) - price) < 1e-9
    except ValueError:
        return False


# tick, expected decimals, sample on-grid price
CASES = [
    (0.25, 2, 4145.75),
    (0.25, 2, 4046.25),
    (0.025, 3, 1.025),
    (0.125, 3, 10.125),
    (0.1, 1, 1.3),
    (0.01, 2, 1.23),
    (0.005, 3, 1.005),
]

# Ticks whose old formula drops a digit. The displayed string must NOT round-trip.
OLD_FAILS = [(0.25, 4145.75), (0.025, 1.025), (0.125, 10.125)]


def main() -> int:
    problems = []
    for tick, decimals, price in CASES:
        got = tick_decimals(tick)
        if got != decimals:
            problems.append(f"tick {tick}: decimals {got}, expected {decimals}")
            continue
        shown = format_price(price, got, tick)
        if not parses_back(shown, price):
            problems.append(f"tick {tick}: {price} displayed as {shown!r}")
    for tick, price in OLD_FAILS:
        shown = format_price(price, old_log10_precision(tick), tick)
        if parses_back(shown, price):
            problems.append(
                f"old formula unexpectedly round-tripped {price} at tick {tick} as {shown!r}"
            )
    # The known v0.1.1 screenshot: 4145.75 shown as 4145.5.
    legacy = format_price(4145.75, old_log10_precision(0.25), 0.25)
    if legacy != "4145.5":
        problems.append(f"legacy formatter expected 4145.5, got {legacy!r}")
    if problems:
        print("\n".join(problems), file=sys.stderr)
        return 1
    print(f"price axis: {len(CASES)} prices round-trip; legacy 0.25 bug still detected")
    return 0


if __name__ == "__main__":
    sys.exit(main())
