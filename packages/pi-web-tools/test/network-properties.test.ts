import assert from "node:assert/strict";
import { Database, Hegel } from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, test } from "vitest";
import { isPrivateOrLocalIp, parseContentType } from "../network";

const settings = { testCases: 200, seed: 12_345n, database: Database.disabled };

// ---- Independent numeric oracle: IANA non-global IPv4 ranges as [base, prefixLength]. ----
const v4 = (a: number, b: number, c: number, d: number) => ((a * 256 + b) * 256 + c) * 256 + d;
const V4_NON_GLOBAL: readonly (readonly [number, number])[] = [
  [v4(0, 0, 0, 0), 8],
  [v4(10, 0, 0, 0), 8],
  [v4(100, 64, 0, 0), 10],
  [v4(127, 0, 0, 0), 8],
  [v4(169, 254, 0, 0), 16],
  [v4(172, 16, 0, 0), 12],
  [v4(192, 0, 0, 0), 24],
  [v4(192, 0, 2, 0), 24],
  [v4(192, 168, 0, 0), 16],
  [v4(198, 18, 0, 0), 15],
  [v4(198, 51, 100, 0), 24],
  [v4(203, 0, 113, 0), 24],
  [v4(224, 0, 0, 0), 4],
  [v4(240, 0, 0, 0), 4],
];
function v4NonGlobal(value: number): boolean {
  return V4_NON_GLOBAL.some(([base, length]) => {
    const size = 2 ** (32 - length);
    return value >= base && value < base + size;
  });
}

// IPv6 as eight 16-bit groups; prefix tests compare the leading bits as a bigint.
const toBig = (groups: readonly number[]) =>
  groups.reduce((acc, group) => (acc << 16n) | BigInt(group), 0n);
function inV6(groups: readonly number[], base: readonly number[], length: number): boolean {
  const shift = BigInt(128 - length);
  return toBig(groups) >> shift === toBig(base) >> shift;
}
const embedded = (high: number, low: number) => high * 65_536 + low;

function v6NonGlobal(g: readonly number[]): boolean {
  if (inV6(g, [0, 0, 0, 0, 0, 0xff_ff, 0, 0], 96) || inV6(g, [0, 0, 0, 0, 0xff_ff, 0, 0, 0], 96)) {
    return v4NonGlobal(embedded(g[6] ?? 0, g[7] ?? 0)); // mapped and SIIT
  }
  if (inV6(g, [0x20_02, 0, 0, 0, 0, 0, 0, 0], 16)) {
    return v4NonGlobal(embedded(g[1] ?? 0, g[2] ?? 0)); // 6to4
  }
  const ranges: readonly (readonly [number[], number])[] = [
    [[0, 0, 0, 0, 0, 0, 0, 0], 96],
    [[0x64, 0xff_9b, 0, 0, 0, 0, 0, 0], 96],
    [[0x64, 0xff_9b, 1, 0, 0, 0, 0, 0], 48],
    [[0xfc_00, 0, 0, 0, 0, 0, 0, 0], 7],
    [[0xfe_80, 0, 0, 0, 0, 0, 0, 0], 10],
    [[0xff_00, 0, 0, 0, 0, 0, 0, 0], 8],
    [[0x20_01, 0xd_b8, 0, 0, 0, 0, 0, 0], 32],
    [[0x1_00, 0, 0, 0, 0, 0, 0, 0], 64],
  ];
  return ranges.some(([base, length]) => inV6(g, base, length));
}

// ---- Generators biased to range boundaries. ----
const BOUNDARY_OCTETS = [
  0, 1, 2, 3, 9, 10, 11, 15, 16, 17, 31, 32, 63, 64, 65, 100, 113, 126, 127, 128, 168, 169, 171,
  172, 173, 191, 192, 193, 197, 198, 199, 200, 203, 204, 223, 224, 239, 240, 254, 255,
];
const octet = gs.oneOf(
  gs.sampledFrom(BOUNDARY_OCTETS),
  gs.integers({ minValue: 0, maxValue: 255 }),
);
const group = gs.oneOf(
  gs.sampledFrom([
    0, 1, 0xff_ff, 0x20_02, 0xd_b8, 0x20_01, 0x64, 0xff_9b, 0xfe_80, 0xfc_00, 0xff_00,
  ]),
  gs.integers({ minValue: 0, maxValue: 0xff_ff }),
);
const randomOctets = gs.arrays(octet, { minSize: 4, maxSize: 4 });
// Addresses at the first/last/just-outside edge of each oracle range, so small ranges are hit.
const edgeOctets = gs.composite((tc) => {
  const [base, length] = tc.draw(gs.sampledFrom(V4_NON_GLOBAL), "range");
  const size = 2 ** (32 - length);
  const offset = tc.draw(gs.sampledFrom([-1, 0, 1, size - 1, size, size + 1]), "offset");
  const value = Math.min(Math.max(base + offset, 0), 2 ** 32 - 1);
  return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
});
const ipv4Octets = gs.oneOf(randomOctets, edgeOctets);
const toGroups = (o: readonly number[]) => [
  (o[0] ?? 0) * 256 + (o[1] ?? 0),
  (o[2] ?? 0) * 256 + (o[3] ?? 0),
];

// Prefix templates; undefined slots are free groups.
const V6_PREFIXES: readonly (readonly (number | undefined)[])[] = [
  [0, 0, 0, 0, 0, 0xff_ff], // mapped
  [0, 0, 0, 0, 0xff_ff, 0], // SIIT
  [0, 0, 0, 0, 0, 0], // compatible
  [0x64, 0xff_9b, 0, 0, 0, 0], // NAT64
  [0x64, 0xff_9b, 1], // local-use NAT64
  [0x20_02], // 6to4
  [0x20_01, 0xd_b8],
  [0x1_00, 0, 0, 0],
  [0xfe_80],
  [0xfc_00],
  [],
];
const v6Groups = gs.composite((tc) => {
  const prefix = tc.draw(gs.sampledFrom(V6_PREFIXES), "prefix");
  const free = tc.draw(gs.arrays(group, { minSize: 8, maxSize: 8 }), "free");
  const tailV4 = tc.draw(gs.booleans(), "v4Tail");
  const result = free.map((value, index) => prefix[index] ?? value);
  if (tailV4 && prefix.length >= 3) {
    const [high, low] = toGroups(tc.draw(ipv4Octets, "tail"));
    result[6] = high ?? 0;
    result[7] = low ?? 0;
  }
  return result;
});

const hex = (groups: readonly number[], upper: boolean) => {
  const text = groups.map((g) => g.toString(16)).join(":");
  return upper ? text.toUpperCase() : text;
};
const dottedTail = (groups: readonly number[]) => {
  const [high = 0, low = 0] = [groups[6], groups[7]];
  return `${groups
    .slice(0, 6)
    .map((g) => g.toString(16))
    .join(":")}:${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
};

function checkV4(o: number[]): void {
  const [a = 0, b = 0, c = 0, d = 0] = o;
  assert.equal(isPrivateOrLocalIp(o.join(".")), v4NonGlobal(v4(a, b, c, d)));
}

// Range edges: first/last address of each table range and their neighbours, where an off-by-one or a dropped range shows.
function checkEdge(index: number, atEnd: boolean, delta: number): void {
  const [base = 0, length = 0] = V4_NON_GLOBAL[index] ?? [];
  const value = base + (atEnd ? 2 ** (32 - length) - 1 : 0) + delta;
  if (value < 0 || value > 2 ** 32 - 1) {
    return;
  }
  const octets = [24, 16, 8, 0].map((shift) => Math.floor(value / 2 ** shift) % 256);
  assert.equal(isPrivateOrLocalIp(octets.join(".")), v4NonGlobal(value), octets.join("."));
}

describe("isPrivateOrLocalIp properties", () => {
  test("IPv4 verdict is right at every range edge", () => {
    new Hegel((tc) => {
      expect(() => {
        checkEdge(
          tc.draw(gs.integers({ minValue: 0, maxValue: V4_NON_GLOBAL.length - 1 }), "range"),
          tc.draw(gs.booleans(), "atEnd"),
          tc.draw(gs.sampledFrom([-1, 0, 1]), "delta"),
        );
      }).not.toThrow();
    })
      .databaseKey("pi-web-tools/private-ip-v4-edges")
      .settings(settings)
      .runSync();
  });

  test("IPv4 verdict matches the numeric IANA range table", () => {
    new Hegel((tc) => {
      expect(() => {
        checkV4(tc.draw(ipv4Octets, "octets"));
      }).not.toThrow();
    })
      .databaseKey("pi-web-tools/private-ip-v4")
      .settings(settings)
      .runSync();
  });

  test("IPv6 verdict matches the numeric table, in every spelling", () => {
    new Hegel((tc) => {
      const groups = tc.draw(v6Groups, "groups");
      const expected = v6NonGlobal(groups);
      expect(isPrivateOrLocalIp(hex(groups, false)), "lower").toBe(expected);
      expect(isPrivateOrLocalIp(hex(groups, true)), "upper").toBe(expected);
      expect(isPrivateOrLocalIp(`[${hex(groups, false)}]`), "bracketed").toBe(expected);
      expect(isPrivateOrLocalIp(dottedTail(groups)), "dotted tail").toBe(expected);
    })
      .databaseKey("pi-web-tools/private-ip-v6")
      .settings(settings)
      .runSync();
  });

  test("arbitrary text never throws and non-IPs are not private", () => {
    new Hegel((tc) => {
      const text = tc.draw(gs.text({ maxSize: 40 }), "text");
      expect(typeof isPrivateOrLocalIp(text)).toBe("boolean");
      // A leading letter outside hex digits can never be an IP literal.
      expect(isPrivateOrLocalIp(`x${text}`)).toBe(false);
    })
      .databaseKey("pi-web-tools/private-ip-text")
      .settings(settings)
      .runSync();
  });
});

describe("parseContentType charset properties", () => {
  const NAMES = ["foo", "charset", "xcharset", "charsetx", "Charset", "a-charset", "q"];
  const VALUES = ["utf-8", "ISO-8859-1", "x", "Shift_JIS"];
  test("only a parameter named exactly charset sets the charset", () => {
    new Hegel((tc) => {
      const params = tc.draw(
        gs.arrays(
          gs.tuples(
            gs.sampledFrom(NAMES),
            gs.sampledFrom(VALUES),
            gs.sampledFrom(["", '"', "'"]),
            gs.sampledFrom(["", " "]),
          ),
          { maxSize: 4 },
        ),
        "params",
      );
      const header = [
        "text/html",
        ...params.map(([n, v, q, s]) => `${s}${n}${s}=${s}${q}${v}${q}`),
      ].join(";");
      const first = params.find(([name]) => name.toLowerCase() === "charset");
      expect(parseContentType(header).charset).toBe(first?.[1].toLowerCase());
    })
      .databaseKey("pi-web-tools/content-type-charset")
      .settings(settings)
      .runSync();
  });
});
