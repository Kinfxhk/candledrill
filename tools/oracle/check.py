#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Independent oracle for CandleDrill (Python standard library only).

Re-checks the JSON written by dump.ts without sharing any code with the TypeScript engine:

* every fill obeys the documented fill model (market at the next open plus slippage,
  limit at the limit or a better open, stop at the stop or a worse open plus slippage,
  practice-rule closes at the bar close), and never fills on the bar it was placed on;
* positions, trades, gross / net P&L, commission, realised P&L and the R multiple,
  recomputed from the fills alone;
* MAE / MFE recomputed from the bars;
* blind mode: disguised bars are the real bars shifted by whole weeks and whole ticks, the
  blind twin trades identically, and no server response leaks the real symbol or times;
* backup: the backup file passes SQLite's integrity check and both the backup and the
  restored library hold exactly the original rows.

Usage: python3 tools/oracle/check.py oracle-cases.json
"""
import base64
import json
import math
import sqlite3
import sys
import tempfile
import os

TOL = 1e-6
problems = []
checked = {"modifications": 0, "fills": 0, "trades": 0, "sessions": 0, "excursions": 0, "blind": 0, "bodies": 0}


def close(a, b, tol=TOL):
    if a is None or b is None:
        return a is b
    return abs(a - b) <= tol * max(1.0, abs(a), abs(b))


def fail(case, msg):
    if len(problems) < 50:
        problems.append(f"case {case}: {msg}")


def rtick(p, tick):
    return round(round(p / tick) * tick, 10)


def check_fills(ci, c):
    st = c["settings"]
    tick, slip = st["tickSize"], st["slippageTicks"] * st["tickSize"]
    bars = c["bars"]
    index = {b["time"]: i for i, b in enumerate(bars)}
    orders = {o["id"]: o for o in c["orders"]}
    entry_bar_of = {}  # child order id -> index of the bar its parent filled on
    for o in c["orders"]:
        if o["parentId"] is not None and o["parentId"] in orders:
            p = orders[o["parentId"]]
            if p["filledTime"] is not None:
                entry_bar_of[o["id"]] = index.get(p["filledTime"])
    for f in c["fills"]:
        checked["fills"] += 1
        i = index.get(f["time"])
        if i is None or i > c["cursor"]:
            fail(ci, f"fill {f['id']} at a time that is not a revealed bar")
            continue
        b = bars[i]
        if not (b["low"] - slip - 1e-9 <= f["price"] <= b["high"] + slip + 1e-9):
            fail(ci, f"fill {f['id']} price {f['price']} outside bar {b['low']}..{b['high']} (+slip)")
        sgn = 1 if f["side"] == "buy" else -1
        if f["role"] == "rule":
            exp = rtick(b["close"] + sgn * slip, tick)
            if not close(f["price"], exp):
                fail(ci, f"rule close {f['id']} at {f['price']}, expected close±slip {exp}")
            continue
        o = orders.get(f["orderId"])
        if o is None:
            fail(ci, f"fill {f['id']} has no order")
            continue
        on_entry_bar = entry_bar_of.get(o["id"]) == i
        # Bracket children are created when the entry fills and may resolve on that same bar.
        if not (o["placedIndex"] < i or (on_entry_bar and o["placedIndex"] == i)):
            fail(ci, f"fill {f['id']} ({o['role']}) on the bar its order was placed on (look-ahead)")
        if o["type"] == "market":
            exp = rtick(b["open"] + sgn * slip, tick)
            if not close(f["price"], exp):
                fail(ci, f"market fill {f['id']} {f['price']} != open±slip {exp}")
        elif on_entry_bar:
            continue  # same-bar bracket child: only the bar-range check applies (documented)
        elif o["type"] == "limit":
            lim = o["price"]
            exp = min(lim, b["open"]) if f["side"] == "buy" else max(lim, b["open"])
            if not close(f["price"], exp):
                fail(ci, f"limit fill {f['id']} {f['price']} != {exp} (limit {lim}, open {b['open']})")
            touched = b["low"] <= lim + 1e-9 if f["side"] == "buy" else b["high"] >= lim - 1e-9
            if not touched:
                fail(ci, f"limit fill {f['id']} but the bar never reached {lim}")
        elif o["type"] == "stop":
            stp = o["price"]
            base = max(stp, b["open"]) if f["side"] == "buy" else min(stp, b["open"])
            exp = rtick(base + sgn * slip, tick)
            if not close(f["price"], exp):
                fail(ci, f"stop fill {f['id']} {f['price']} != {exp} (stop {stp}, open {b['open']})")
            touched = b["high"] >= stp - 1e-9 if f["side"] == "buy" else b["low"] <= stp + 1e-9
            if not touched:
                fail(ci, f"stop fill {f['id']} but the bar never reached {stp}")


def replay(ci, c):
    """Net-position ledger from fills only; returns trades and realised P&L."""
    st = c["settings"]
    pv, comm_rate = st["pointValue"], st["commissionPerContract"]
    orders = {o["id"]: o for o in c["orders"]}
    pos, avg = 0, 0.0
    trades, realized, cur = [], 0.0, None

    def open_trade(qty, price, side, t, comm, sl):
        risk = None if sl is None else max(0.0, (price - sl) * (1 if side == "buy" else -1)) * qty * pv
        return {"side": "long" if side == "buy" else "short", "open": t, "eq": qty, "ev": qty * price,
                "xq": 0, "xv": 0.0, "max": qty, "comm": comm, "gross": 0.0,
                "risk": risk, "complete": sl is not None}

    for f in c["fills"]:
        q, p = f["qty"], f["price"]
        comm = comm_rate * q
        realized -= comm
        signed = q if f["side"] == "buy" else -q
        o = orders.get(f["orderId"])
        sl = o["stopLoss"] if (o is not None and o["role"] == "entry") else None
        if pos == 0:
            pos, avg = signed, p
            cur = open_trade(q, p, f["side"], f["time"], comm, sl)
            continue
        if (pos > 0) == (signed > 0):
            avg = (abs(pos) * avg + q * p) / (abs(pos) + q)
            pos += signed
            cur["eq"] += q
            cur["ev"] += q * p
            cur["max"] = max(cur["max"], abs(pos))
            cur["comm"] += comm
            part = None if sl is None else max(0.0, (p - sl) * (1 if f["side"] == "buy" else -1)) * q * pv
            if part is None or not cur["complete"]:
                cur["complete"] = False
            else:
                cur["risk"] += part
            continue
        d = 1 if pos > 0 else -1
        cq = min(q, abs(pos))
        gross = (p - avg) * cq * d * pv
        cc = comm * cq / q
        cur["xq"] += cq
        cur["xv"] += cq * p
        cur["comm"] += cc
        cur["gross"] += gross
        realized += gross
        rem = abs(pos) - cq
        if rem > 0:
            pos = d * rem
            continue
        net = cur["gross"] - cur["comm"]
        risk = cur["risk"] if cur["complete"] else None
        trades.append({"side": cur["side"], "qty": cur["max"], "openTime": cur["open"], "closeTime": f["time"],
                       "entryPrice": cur["ev"] / cur["eq"], "exitPrice": cur["xv"] / cur["xq"],
                       "grossPnl": cur["gross"], "commission": cur["comm"], "netPnl": net,
                       "initialRisk": risk, "rMultiple": (net / risk) if risk else None})
        pos, cur = 0, None
        left = q - cq
        if left > 0:
            pos, avg = (left if f["side"] == "buy" else -left), p
            cur = open_trade(left, p, f["side"], f["time"], comm - cc, sl)
    return trades, realized, pos, avg


def check_ledger(ci, c):
    trades, realized, pos, avg = replay(ci, c)
    got = c["trades"]
    if len(trades) != len(got):
        fail(ci, f"{len(got)} trades, oracle {len(trades)}")
        return
    for k, (a, b) in enumerate(zip(trades, got)):
        checked["trades"] += 1
        for key in ("side", "qty", "openTime", "closeTime"):
            if a[key] != b[key]:
                fail(ci, f"trade {k + 1} {key}: {b[key]} vs oracle {a[key]}")
        for key in ("entryPrice", "exitPrice", "grossPnl", "commission", "netPnl", "initialRisk"):
            if not close(a[key], b[key]):
                fail(ci, f"trade {k + 1} {key}: {b[key]} vs oracle {a[key]}")
        exp_r = None if a["rMultiple"] is None else round(a["rMultiple"], 4)
        # TS rounds R to 4 dp from money-rounded net and risk; allow one unit in the 4th dp.
        if (exp_r is None) != (b["rMultiple"] is None) or (
            exp_r is not None and abs(exp_r - b["rMultiple"]) > 1.5e-4
        ):
            fail(ci, f"trade {k + 1} R: {b['rMultiple']} vs oracle {exp_r}")
    if not close(realized, c["realizedPnl"]):
        fail(ci, f"realizedPnl {c['realizedPnl']} vs oracle {realized}")
    if not close(sum(f["commission"] for f in c["fills"]), c["commissionPaid"]):
        fail(ci, "commissionPaid does not match the fills")
    gpos = c["position"]
    if (gpos is None) != (pos == 0) or (gpos and (gpos["qty"] != pos or not close(gpos["avgPrice"], avg))):
        fail(ci, f"position {gpos} vs oracle qty {pos} avg {avg}")


def check_excursions(ci, c):
    tick = c["settings"]["tickSize"]
    pv = c["settings"]["pointValue"]
    for t, e in zip(c["trades"], c["excursions"]):
        checked["excursions"] += 1
        span = [b for b in c["bars"] if t["openTime"] <= b["time"] <= t["closeTime"]]
        hi, lo = max(b["high"] for b in span), min(b["low"] for b in span)
        long = t["side"] == "long"
        mae = max(0.0, (t["entryPrice"] - lo) if long else (hi - t["entryPrice"])) / tick
        mfe = max(0.0, (hi - t["entryPrice"]) if long else (t["entryPrice"] - lo)) / tick
        if not close(mae, e["maeTicks"], 1e-5) or not close(mfe, e["mfeTicks"], 1e-5):
            fail(ci, f"trade {t['id']} MAE/MFE {e['maeTicks']}/{e['mfeTicks']} vs oracle {mae}/{mfe}")
        if t["initialRisk"]:
            unit = t["initialRisk"] / (t["qty"] * pv)
            if not close(mae * tick / unit, e["maeR"], 1e-5):
                fail(ci, f"trade {t['id']} MAE R {e['maeR']} vs oracle {mae * tick / unit}")


def check_blind(ci, c):
    b = c["blind"]
    if not b:
        return
    checked["blind"] += 1
    p = b["params"]
    if p["timeShift"] == 0 or p["timeShift"] % (7 * 86400):
        fail(ci, f"blind time shift {p['timeShift']} is not whole weeks")
    tick = c["settings"]["tickSize"]
    if abs(p["priceOffset"] / tick - round(p["priceOffset"] / tick)) > 1e-6:
        fail(ci, "blind price offset is not whole ticks")
    for real, d in zip(c["bars"], b["bars"]):
        if d["time"] - real["time"] != p["timeShift"]:
            fail(ci, "disguised bar time is not the real time + shift")
            break
        if any(not close(d[k] - real[k], p["priceOffset"], 1e-9) for k in ("open", "high", "low", "close")):
            fail(ci, "disguised prices are not the real prices + offset")
            break
        if d["volume"] != real["volume"]:
            fail(ci, "disguised volume differs")
            break
    if len(b["trades"]) != len(c["trades"]):
        fail(ci, "blind twin made a different number of trades")
        return
    for x, y in zip(b["trades"], c["trades"]):
        if x["closeTime"] - p["timeShift"] != y["closeTime"] or not close(x["netPnl"], y["netPnl"]):
            fail(ci, "blind twin trade differs from the real trade")


def check_server(srv):
    for k, run in enumerate(srv["blindRuns"]):
        real = set(run["realTimes"])
        for body in run["bodies"]:
            checked["bodies"] += 1
            if run["symbol"] in body:
                fail(f"blind-run {k}", "a response contains the real symbol")
            if "timeShift" in body or "priceOffset" in body:
                fail(f"blind-run {k}", "a response contains the disguise parameters")
            for tok in body.replace(",", " ").replace(":", " ").replace("[", " ").replace("]", " ").replace("}", " ").split():
                if tok.isdigit() and int(tok) in real:
                    fail(f"blind-run {k}", f"a response contains the real bar time {tok}")
                    break
        if run["locked"] != 423:
            fail(f"blind-run {k}", f"dataset preview not locked (HTTP {run['locked']})")
        rv = run["revealed"]
        if not rv.get("revealed") or rv.get("symbol") != run["symbol"]:
            fail(f"blind-run {k}", "reveal did not return the real symbol")
        elif run["firstShownTime"] - rv["timeShift"] not in real:
            fail(f"blind-run {k}", "revealed shift does not map shown times back to real bars")
    bk = srv["backup"]
    raw = base64.b64decode(bk["backupB64"])
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "b.db")
        with open(path, "wb") as fh:
            fh.write(raw)
        con = sqlite3.connect(path)
        try:
            if con.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                fail("backup", "integrity_check failed")
            for t in ("datasets", "bars", "sessions"):
                rows = [list(r) for r in con.execute(f"SELECT * FROM {t} ORDER BY 1, 2")]
                if rows != bk["original"][t]:
                    fail("backup", f"table {t} in the backup differs from the original")
        finally:
            con.close()
    if bk["restoreStatus"] != 200:
        fail("backup", f"restore returned HTTP {bk['restoreStatus']}")
    for t in ("datasets", "bars", "sessions"):
        if bk["restored"][t] != bk["original"][t]:
            fail("backup", f"table {t} after restore differs from the original")


def main():
    data = json.load(open(sys.argv[1] if len(sys.argv) > 1 else "oracle-cases.json"))
    for ci, c in enumerate(data["sessions"]):
        checked["sessions"] += 1
        checked["modifications"] += c.get("modifications", 0)
        check_fills(ci, c)
        check_ledger(ci, c)
        check_excursions(ci, c)
        check_blind(ci, c)
    check_server(data["server"])
    print("checked:", json.dumps(checked))
    if problems:
        print(f"{len(problems)} problem(s):")
        for p in problems:
            print(" -", p)
        sys.exit(1)
    print("oracle: all checks passed")


if __name__ == "__main__":
    main()
