"""Checks a .wasm file for features the Casper node rejects.
Usage:  python check_wasm.py path\\to\\file.wasm
"""
import sys


def uleb(b, i):
    r = s = 0
    while True:
        x = b[i]; i += 1
        r |= (x & 0x7F) << s; s += 7
        if not x & 0x80:
            return r, i


def sleb(b, i):
    r = s = 0
    while True:
        x = b[i]; i += 1
        r |= (x & 0x7F) << s; s += 7
        if not x & 0x80:
            if x & 0x40:
                r -= 1 << s
            return r, i


def scan_body(b, i, end, found):
    n, i = uleb(b, i)
    for _ in range(n):
        _, i = uleb(b, i); i += 1
    while i < end:
        op = b[i]; i += 1
        if op in (0x02, 0x03, 0x04):
            v, i = sleb(b, i)
            if v >= 0: found.add("multi-value block")
        elif op in (0x0C, 0x0D, 0x10, 0x20, 0x21, 0x22, 0x23, 0x24):
            _, i = uleb(b, i)
        elif op == 0x0E:
            n, i = uleb(b, i)
            for _ in range(n + 1): _, i = uleb(b, i)
        elif op == 0x11:
            _, i = uleb(b, i); _, i = uleb(b, i)
        elif op == 0x1C:
            n, i = uleb(b, i); i += n; found.add("typed select (reference types)")
        elif op in (0x25, 0x26):
            _, i = uleb(b, i); found.add("table.get/set (reference types)")
        elif 0x28 <= op <= 0x3E:
            _, i = uleb(b, i); _, i = uleb(b, i)
        elif op in (0x3F, 0x40):
            i += 1
        elif op in (0x41, 0x42):
            _, i = sleb(b, i)
        elif op == 0x43: i += 4
        elif op == 0x44: i += 8
        elif 0xC0 <= op <= 0xC4:
            found.add("sign-extension ops")
        elif op in (0xD0,): i += 1; found.add("reference types")
        elif op in (0xD1,): found.add("reference types")
        elif op == 0xD2:
            _, i = uleb(b, i); found.add("reference types")
        elif op == 0xFC:
            sub, i = uleb(b, i)
            if sub <= 7: found.add("saturating float-to-int")
            elif sub == 8: _, i = uleb(b, i); i += 1; found.add("BULK MEMORY (memory.init)")
            elif sub == 9: _, i = uleb(b, i); found.add("BULK MEMORY (data.drop)")
            elif sub == 10: i += 2; found.add("BULK MEMORY (memory.copy)")
            elif sub == 11: i += 1; found.add("BULK MEMORY (memory.fill)")
            elif sub in (12, 14): _, i = uleb(b, i); _, i = uleb(b, i); found.add("table ops (reference types)")
            else: _, i = uleb(b, i); found.add("table ops (reference types)")
        elif op == 0xFD:
            found.add("SIMD"); return
        elif op in (0x00, 0x01, 0x05, 0x0B, 0x0F, 0x1A, 0x1B) or 0x45 <= op <= 0xBF:
            pass
        else:
            found.add(f"unknown opcode 0x{op:02x}"); return


def check(path):
    b = open(path, "rb").read()
    if b[:4] != b"\0asm":
        print("Not a wasm file."); return 2
    i, found, hasdata = 8, set(), False
    while i < len(b):
        sid = b[i]; i += 1
        size, i = uleb(b, i)
        end = i + size
        if sid == 12: hasdata = True
        if sid == 10:
            n, j = uleb(b, i)
            for _ in range(n):
                bs, j = uleb(b, j)
                scan_body(b, j, j + bs, found)
                j += bs
        i = end
    print(f"File: {path}\nSize: {len(b)} bytes")
    bad = [f for f in found if f.isupper() or "BULK" in f or "reference" in f or "multi-value" in f or "SIMD" in f or "table" in f]
    warn = [f for f in found if f not in bad]
    for f in sorted(found): print(" - found:", f)
    if hasdata: print(" - note: has a data-count section (bulk memory marker)")
    if bad or hasdata:
        print("\nRESULT: NOT SAFE. Casper will reject this file. Do NOT deploy.")
        return 1
    if warn:
        print("\nRESULT: probably OK, but contains:", ", ".join(warn))
        return 0
    print("\nRESULT: OK. No unsupported WebAssembly features found.")
    return 0


if __name__ == "__main__":
    sys.exit(check(sys.argv[1]) if len(sys.argv) > 1 else print(__doc__))