import assert from "node:assert/strict";
import * as gs from "@hegeldev/hegel/generators";
import { Result, Schema } from "effect";
import { describe, expect, test } from "vitest";
import { propertySettings, assertHegel } from "../../../test-support/hegel-settings";
import { isPrivateOrLocalIp, parseContentType } from "../network";
import { parsePublicHttpUrl } from "../types";

const settings = propertySettings(200);

const ipv4Value = (a: number, b: number, c: number, d: number) =>
  ((a * 256 + b) * 256 + c) * 256 + d;
const IANA_NON_GLOBAL_V4: readonly (readonly [number, number])[] = [
  [ipv4Value(0, 0, 0, 0), 8],
  [ipv4Value(10, 0, 0, 0), 8],
  [ipv4Value(100, 64, 0, 0), 10],
  [ipv4Value(127, 0, 0, 0), 8],
  [ipv4Value(169, 254, 0, 0), 16],
  [ipv4Value(172, 16, 0, 0), 12],
  [ipv4Value(192, 0, 0, 0), 24],
  [ipv4Value(192, 0, 2, 0), 24],
  [ipv4Value(192, 168, 0, 0), 16],
  [ipv4Value(198, 18, 0, 0), 15],
  [ipv4Value(198, 51, 100, 0), 24],
  [ipv4Value(203, 0, 113, 0), 24],
  [ipv4Value(224, 0, 0, 0), 4],
  [ipv4Value(240, 0, 0, 0), 4],
];
function v4NonGlobal(value: number): boolean {
  return IANA_NON_GLOBAL_V4.some(([base, length]) => {
    const size = 2 ** (32 - length);
    return value >= base && value < base + size;
  });
}

const toBig = (groups: readonly number[]) =>
  groups.reduce((acc, group) => (acc << 16n) | BigInt(group), 0n);
function inV6(groups: readonly number[], base: readonly number[], length: number): boolean {
  const shift = BigInt(128 - length);
  return toBig(groups) >> shift === toBig(base) >> shift;
}
const embedded = (high: number, low: number) => high * 65_536 + low;

function v6NonGlobal(g: readonly number[]): boolean {
  const mappedOrSiit =
    inV6(g, [0, 0, 0, 0, 0, 0xff_ff, 0, 0], 96) || inV6(g, [0, 0, 0, 0, 0xff_ff, 0, 0, 0], 96);
  if (mappedOrSiit) {
    return v4NonGlobal(embedded(g[6] ?? 0, g[7] ?? 0));
  }
  const sixToFour = inV6(g, [0x20_02, 0, 0, 0, 0, 0, 0, 0], 16);
  if (sixToFour) {
    return v4NonGlobal(embedded(g[1] ?? 0, g[2] ?? 0));
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
const edgeOctets = gs.composite((tc) => {
  const [base, length] = tc.draw(gs.sampledFrom(IANA_NON_GLOBAL_V4), "range");
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

const V6_PREFIX_TEMPLATES = {
  mapped: [0, 0, 0, 0, 0, 0xff_ff],
  siit: [0, 0, 0, 0, 0xff_ff, 0],
  siitLookAlikeWithFreeGroupFive: [0, 0, 0, 0, 0xff_ff],
  compatible: [0, 0, 0, 0, 0, 0],
  nat64: [0x64, 0xff_9b, 0, 0, 0, 0],
  localUseNat64: [0x64, 0xff_9b, 1],
  sixToFour: [0x20_02],
  documentation: [0x20_01, 0xd_b8],
  discardOnly: [0x1_00, 0, 0, 0],
  linkLocal: [0xfe_80],
  uniqueLocal: [0xfc_00],
  unconstrained: [],
};
const V6_PREFIXES = Object.values(V6_PREFIX_TEMPLATES);
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
  assert.equal(isPrivateOrLocalIp(o.join(".")), v4NonGlobal(ipv4Value(a, b, c, d)));
}

function checkEdge(index: number, atEnd: boolean, delta: number): void {
  const [base = 0, length = 0] = IANA_NON_GLOBAL_V4[index] ?? [];
  const value = base + (atEnd ? 2 ** (32 - length) - 1 : 0) + delta;
  if (value < 0 || value > 2 ** 32 - 1) {
    return;
  }
  const octets = [24, 16, 8, 0].map((shift) => Math.floor(value / 2 ** shift) % 256);
  assert.equal(isPrivateOrLocalIp(octets.join(".")), v4NonGlobal(value), octets.join("."));
}

type Spelling = (octets: readonly number[]) => string;
const whole = (octets: readonly number[]) => octets.reduce((acc, part) => acc * 256 + part, 0);
const tail = (octets: readonly number[], keep: number) =>
  octets.slice(keep).reduce((acc, part) => acc * 256 + part, 0);
const NUMERIC_SPELLINGS: readonly Spelling[] = [
  (o) => String(whole(o)),
  (o) => `0x${whole(o).toString(16)}`,
  (o) => `0${whole(o).toString(8)}`,
  (o) => o.map((part) => `0x${part.toString(16)}`).join("."),
  (o) => o.map((part) => `0${part.toString(8)}`).join("."),
  (o) => o.join("."),
  (o) => `${o[0] ?? 0}.${o[1] ?? 0}.${tail(o, 2)}`,
  (o) => `${o[0] ?? 0}.${tail(o, 1)}`,
  (o) => `0x${(o[0] ?? 0).toString(16)}.${tail(o, 1)}`,
];

describe("isPrivateOrLocalIp properties", () => {
  test("IPv4 verdict is right at every range edge", () => {
    assertHegel(settings, (tc) => {
      checkEdge(
        tc.draw(gs.integers({ minValue: 0, maxValue: IANA_NON_GLOBAL_V4.length - 1 }), "range"),
        tc.draw(gs.booleans(), "atEnd"),
        tc.draw(gs.sampledFrom([-1, 0, 1]), "delta"),
      );
    });
  });

  test("IPv4 verdict matches the numeric IANA range table", () => {
    assertHegel(settings, (tc) => {
      checkV4(tc.draw(ipv4Octets, "octets"));
    });
  });

  test("IPv6 verdict matches the numeric table, in every spelling", () => {
    assertHegel(settings, (tc) => {
      const groups = tc.draw(v6Groups, "groups");
      const expected = v6NonGlobal(groups);
      expect(isPrivateOrLocalIp(hex(groups, false)), "lower").toBe(expected);
      expect(isPrivateOrLocalIp(hex(groups, true)), "upper").toBe(expected);
      expect(isPrivateOrLocalIp(`[${hex(groups, false)}]`), "bracketed").toBe(expected);
      expect(isPrivateOrLocalIp(dottedTail(groups)), "dotted tail").toBe(expected);
    });
  });

  test("every legacy numeric spelling of an IPv4 host gets the dotted-quad verdict", () => {
    assertHegel(settings, (tc) => {
      const octets = tc.draw(ipv4Octets, "octets");
      const spelling = tc.draw(gs.sampledFrom(NUMERIC_SPELLINGS), "spelling");
      const [a = 0, b = 0, c = 0, d = 0] = octets;
      const parsed = parsePublicHttpUrl(`http://${spelling(octets)}/`);
      assert.ok(Result.isSuccess(parsed), `${spelling(octets)} did not parse`);
      const { hostname } = new URL(parsed.success);
      assert.equal(hostname, octets.join("."), "the URL parser canonicalises the host");
      assert.equal(isPrivateOrLocalIp(hostname), v4NonGlobal(ipv4Value(a, b, c, d)), hostname);
    });
  });

  test("arbitrary text never throws and non-IPs are not private", () => {
    assertHegel(settings, (tc) => {
      const text = tc.draw(gs.text({ maxSize: 40 }), "text");
      expect(isPrivateOrLocalIp(text)).toSatisfy(Schema.is(Schema.Boolean));
      expect(isPrivateOrLocalIp(`x${text}`)).toBe(false);
    });
  });
});

describe("parseContentType charset properties", () => {
  const NAMES = ["foo", "charset", "xcharset", "charsetx", "Charset", "a-charset", "q"];
  const VALUES = ["utf-8", "ISO-8859-1", "x", "Shift_JIS"];
  test("only a parameter named exactly charset sets the charset", () => {
    assertHegel(settings, (tc) => {
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
    });
  });
});
