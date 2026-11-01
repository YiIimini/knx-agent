"""Command line entry point: `python3 -m knxagent.cli <command>`.

Everything the agent runtime can do is reachable here, which keeps the module
useful without an LLM in the loop - and makes each agent step reproducible by
hand when something goes wrong on site.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from typing import Dict, List

from . import cemi, dpt, knxip, link, agent, download as recipe_mod, project as project_mod


def _print(payload) -> None:
    print(json.dumps(payload, indent=2, ensure_ascii=False, default=str))


def _open(args) -> Dict:
    transport = knxip.Tunnel(args.gateway.split(":")[0],
                             int(args.gateway.split(":")[1]) if ":" in args.gateway else 3671,
                             layer=knxip.LAYER_BUSMON if getattr(args, "busmon", False)
                             else knxip.LAYER_LINK)
    return {"transport": transport, "link": link.DeviceLink(transport),
            "bus": link.GroupBus(transport)}


# ------------------------------------------------------------------ commands
def cmd_search(args) -> int:
    _print({"gateways": knxip.search(timeout=args.timeout,
                                     multicast=not args.no_multicast,
                                     unicast_targets=args.host or None)})
    return 0


def cmd_scan(args) -> int:
    env = _open(args)
    try:
        found = env["link"].scan(args.line, range(args.start, args.end), window=args.window)
        _print({"line": args.line, "devices": found, "count": len(found),
                "transport": env["transport"].stats()})
    finally:
        env["transport"].close()
    return 0


def cmd_info(args) -> int:
    env = _open(args)
    try:
        ia = cemi.parse_ia(args.ia)
        payload = {"ia": args.ia, "descriptor": env["link"].descriptor_read(ia)}
        if args.serial:
            payload["serial"] = env["link"].serial_number()
        _print(payload)
    finally:
        env["transport"].close()
    return 0


def cmd_read(args) -> int:
    env = _open(args)
    try:
        value = env["link"].memory_read(cemi.parse_ia(args.ia), int(args.address, 0), args.count)
        _print({"ok": value is not None, "address": args.address,
                "data": (value or b"").hex()})
    finally:
        env["transport"].close()
    return 0


def cmd_write(args) -> int:
    env = _open(args)
    try:
        data = bytes.fromhex(args.data.replace("0x", "").replace(" ", ""))
        ok = env["link"].memory_write(cemi.parse_ia(args.ia), int(args.address, 0), data)
        _print({"ok": ok, "octets": len(data)})
    finally:
        env["transport"].close()
    return 0


def cmd_monitor(args) -> int:
    env = _open(args)
    try:
        frames = env["bus"].listen(args.seconds,
                                   (lambda f: f["group"]) if args.group_only else None)
        _print({"seconds": args.seconds, "count": len(frames),
                "frames": [{"src": f["src_ia"], "dst": f["dst_text"],
                            "service": f.get("service"),
                            "value": (f.get("value") or b"").hex()} for f in frames]})
    finally:
        env["transport"].close()
    return 0


def cmd_ga(args) -> int:
    env = _open(args)
    try:
        ga = cemi.parse_ga(args.ga)
        if args.value is not None:
            raw = dpt.encode(args.dpt, args.value)
            _print({"written": env["bus"].write(ga, raw), "raw": raw.hex()})
        response = env["bus"].read(ga, args.timeout)
        if response is None:
            _print({"ga": args.ga, "value": None, "error": "no response"})
            return 2
        raw = response.get("value") or b""
        _print({"ga": args.ga, "dpt": args.dpt, "value": dpt.decode(args.dpt, raw),
                "raw": raw.hex(), "source": response.get("src_ia")})
    finally:
        env["transport"].close()
    return 0


def cmd_project(args) -> int:
    if args.path.lower().endswith(".knxprod"):
        _print(project_mod.ProductDatabase(args.path).summary())
        return 0
    parsed = project_mod.KnxProject(args.path)
    if args.json:
        _print({"written": parsed.write_json(args.json)})
    else:
        _print(parsed.summary() if not args.full else parsed.to_dict())
    return 0


def cmd_capture(args) -> int:
    transport = knxip.Tunnel(args.gateway.split(":")[0],
                             int(args.gateway.split(":")[1]) if ":" in args.gateway else 3671,
                             layer=knxip.LAYER_BUSMON)
    try:
        bus = link.GroupBus(transport)
        frames = bus.listen(args.seconds)
    finally:
        transport.close()
    recipe = recipe_mod.capture_to_recipe(frames, cemi.parse_ia(args.ia), name=args.name or "")
    if args.out:
        recipe_mod.save_recipe(recipe, args.out)
    _print({"ok": True, "steps": len(recipe["steps"]), "saved": args.out,
            "recipe": recipe})
    return 0


def cmd_run(args) -> int:
    recipe = recipe_mod.load_recipe(args.recipe)
    env = _open(args)
    try:
        runner = recipe_mod.DownloadRunner(env["link"], env["bus"])
        report = runner.run(recipe, context={"ia": args.ia} if args.ia else None,
                            dry_run=args.dry_run)
        _print(report)
        return 0 if report.get("ok") else 1
    finally:
        env["transport"].close()


def cmd_serve(args) -> int:
    """Run the loopback simulator as a KNXnet/IP gateway on a fixed port."""
    from . import simulate
    devices = [simulate.VirtualDevice(0x1101, 0x07B0, "sim-actor"),
               simulate.VirtualDevice(0x1102, 0x0705, "sim-dimmer"),
               simulate.VirtualDevice(0x1103, 0x0705, "sim-shutter")]
    gateway = simulate.GatewaySim(devices, port=args.port)
    gateway.start()
    print("KNXnet/IP simulator on 127.0.0.1:%d (Ctrl-C to stop)" % gateway.port)
    try:
        while True:
            time.sleep(1.0)
    except KeyboardInterrupt:
        gateway.stop()
    return 0


def cmd_selftest(args) -> int:
    import unittest
    loader = unittest.TestLoader()
    suite = loader.discover("knxagent/tests", top_level_dir=".")
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    return 0 if result.wasSuccessful() else 1


def cmd_plan(args) -> int:
    with open(args.intent, "r", encoding="utf-8") as handle:
        intent = json.load(handle)
    _print({"plan": agent.plan_for_site(intent)})
    return 0


# -------------------------------------------------------------------- parser
def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="knxagent", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("search", help="discover KNXnet/IP gateways")
    p.add_argument("--timeout", type=float, default=3.0)
    p.add_argument("--no-multicast", action="store_true")
    p.add_argument("--host", action="append")
    p.set_defaults(func=cmd_search)

    def with_gateway(p):
        p.add_argument("--gateway", required=True, help="ip or ip:port")
        p.add_argument("--busmon", action="store_true", help="open a bus monitor tunnel")

    p = sub.add_parser("scan", help="scan a line for devices")
    with_gateway(p)
    p.add_argument("--line", default="1.1")
    p.add_argument("--start", type=int, default=0)
    p.add_argument("--end", type=int, default=256)
    p.add_argument("--window", type=int, default=48)
    p.set_defaults(func=cmd_scan)

    p = sub.add_parser("info", help="device identity")
    with_gateway(p)
    p.add_argument("--ia", required=True)
    p.add_argument("--serial", action="store_true")
    p.set_defaults(func=cmd_info)

    p = sub.add_parser("read", help="memory read")
    with_gateway(p)
    p.add_argument("--ia", required=True)
    p.add_argument("--address", required=True)
    p.add_argument("--count", type=int, default=1)
    p.set_defaults(func=cmd_read)

    p = sub.add_parser("write", help="memory write")
    with_gateway(p)
    p.add_argument("--ia", required=True)
    p.add_argument("--address", required=True)
    p.add_argument("--data", required=True)
    p.set_defaults(func=cmd_write)

    p = sub.add_parser("monitor", help="collect bus traffic")
    with_gateway(p)
    p.add_argument("--seconds", type=float, default=10.0)
    p.add_argument("--group-only", action="store_true")
    p.set_defaults(func=cmd_monitor)

    p = sub.add_parser("ga", help="group value read / write")
    with_gateway(p)
    p.add_argument("--ga", required=True)
    p.add_argument("--dpt", default="1.001")
    p.add_argument("--value")
    p.add_argument("--timeout", type=float, default=3.0)
    p.set_defaults(func=cmd_ga)

    p = sub.add_parser("project", help="read a .knxproj or .knxprod")
    p.add_argument("path")
    p.add_argument("--json")
    p.add_argument("--full", action="store_true")
    p.set_defaults(func=cmd_project)

    p = sub.add_parser("capture", help="record a download as a recipe")
    with_gateway(p)
    p.add_argument("--ia", required=True)
    p.add_argument("--seconds", type=float, default=120.0)
    p.add_argument("--name")
    p.add_argument("--out")
    p.set_defaults(func=cmd_capture)

    p = sub.add_parser("run", help="execute a download recipe")
    with_gateway(p)
    p.add_argument("--recipe", required=True)
    p.add_argument("--ia")
    p.add_argument("--dry-run", action="store_true")
    p.set_defaults(func=cmd_run)

    p = sub.add_parser("serve", help="run the built-in KNXnet/IP simulator")
    p.add_argument("--port", type=int, default=3671)
    p.set_defaults(func=cmd_serve)

    p = sub.add_parser("plan", help="turn a commissioning intent into a tool plan")
    p.add_argument("intent")
    p.set_defaults(func=cmd_plan)

    p = sub.add_parser("selftest", help="run the test suite")
    p.set_defaults(func=cmd_selftest)
    return parser


def main(argv=None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
