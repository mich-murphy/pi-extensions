import { Hegel } from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, test } from "vitest";
import { propertySettings } from "../../../test-support/hegel-settings";
import { inspectBashCommand } from "../output-safety";

// These are source strings only. Never submit a test case to a shell.
const WRAPPERS = [
  "command --",
  "command -p --",
  "env -i",
  "env --ignore-environment --",
  "env -u cat",
  "env --unset=cat",
  "env --unset cat -- X=1",
  "sudo -n",
  "sudo -n -u cat",
  "sudo -g cat --",
  "sudo -E -H --",
  "/usr/bin/env -i",
  "/bin/env -i",
  "/usr/bin/sudo -n",
  "command -- env -i sudo -n",
  "env -i command --",
  "sudo -n env -i",
  "exec -a cat --",
  "exec -c -l",
  "nohup --",
  "/usr/bin/nohup --",
  "time -p",
];
const DISCOVERY = ['"$(which node)"', '"$(command -v node)"', "`which node`"];
const UNSUPPORTED = [
  "command -v",
  "command -V",
  "command -pv",
  "command --unknown",
  "env -S",
  "env --split-string",
  "env --unknown",
  "sudo -s",
  "sudo -i",
  "sudo -e",
  "sudo -l",
  "sudo -v",
  "sudo --unknown",
  "sudo -nu",
  "constructor -n",
  "toString -n",
  "__proto__ -n",
  "/tmp/env -i",
  "/usr/bin/command --",
];

describe("explicit executable wrapper semantics", () => {
  test.each(WRAPPERS)("blocks supported wrapper: %s", (wrapper) => {
    expect(inspectBashCommand(`${wrapper} cat "$(which node)"`)).toBeDefined();
  });

  test.each(WRAPPERS)("allows ordinary files and literal documents: %s", (wrapper) => {
    expect(inspectBashCommand(`${wrapper} cat notes.txt`)).toBeUndefined();
    expect(inspectBashCommand(`printf '%s' '${wrapper} cat "$(which node)"'`)).toBeUndefined();
    expect(inspectBashCommand(`cat <<'EOF'\n${wrapper} cat "$(which node)"\nEOF`)).toBeUndefined();
  });

  test.each(UNSUPPORTED)("does not guess through modes or unknown syntax: %s", (wrapper) => {
    expect(inspectBashCommand(`${wrapper} cat "$(which node)"`)).toBeUndefined();
  });

  test.each([
    'env -u cat "$(which node)"',
    'sudo -u cat "$(which node)"',
    'exec -a cat "$(which node)"',
    'env -u "$(which node)" printf cat',
    'sudo -u "$(which node)" printf cat',
    'env -u "$(which node)" cat notes.txt',
    'sudo -u "$(command -v node)" cat notes.txt',
    "env -S 'cat \"$(which node)\"'",
    "sudo -s 'cat \"$(which node)\"'",
    'command -- -v cat "$(which node)"',
    'cat "$(command -V node)"',
    'command -- X=1 cat "$(which node)"',
    'env -- if cat "$(which node)"',
    'env -- X=1 if cat "$(which node)"',
  ])("option values and lookup modes are not executable cat: %s", (source) => {
    expect(inspectBashCommand(source)).toBeUndefined();
  });

  test.each([
    'cat "$(command -v node)"',
    `X='1' cat "$(which node)"`,
    `X="1" cat "$(which node)"`,
    'cat "$(env -i command -v node)"',
    'cat "$(command -p -v node)"',
    'cat "$(sudo -n which node)"',
    'env -S \'ignored\' "$(cat "$(which node)")"',
  ])("preserves discovery and independently executable substitutions: %s", (source) => {
    expect(inspectBashCommand(source)).toBeDefined();
  });

  test.each([
    "time X=1",
    'time X="1"',
    "time X='1'",
    "time !",
    "time -p X=1",
    'time -p X="1"',
    "time -p !",
    "time -p ! env -i",
    "time -p X=1 command -- env -i",
    "time time -p X=1",
    "if time -p X=1",
  ])("reserved shell time preserves prefixes: %s", (prefix) => {
    expect(inspectBashCommand(`${prefix} cat "$(which node)"`)).toBeDefined();
    expect(inspectBashCommand(`${prefix} cat notes.txt`)).toBeUndefined();
    expect(inspectBashCommand(`printf '%s' '${prefix} cat "$(which node)"'`)).toBeUndefined();
    expect(inspectBashCommand(`cat <<'EOF'\n${prefix} cat "$(which node)"\nEOF`)).toBeUndefined();
  });

  test.each([
    '"time" X=1',
    "'time' !",
    String.raw`ti\me -p X="1"`,
    "/usr/bin/time -p X=1",
    "/bin/time !",
    "command -- time X=1",
    'env -- time -p X="1"',
    "sudo -n time !",
    "time -p command -- time X=1",
    "time -p env -- time !",
    "time --unknown X=1",
    "time -o cat X=1",
  ])("nonreserved time and unknown options do not promote shell prefixes: %s", (prefix) => {
    expect(inspectBashCommand(`${prefix} cat "$(which node)"`)).toBeUndefined();
  });

  test("bounded nested wrappers retain positive and negative oracles", () => {
    new Hegel((tc) => {
      const wrappers = tc.draw(
        gs.arrays(gs.sampledFrom(["env -i", "/usr/bin/env --", "nohup --"]), {
          minSize: 1,
          maxSize: 3,
        }),
      );
      const prefix = wrappers.join(tc.draw(gs.sampledFrom([" ", "\t", "  "])));
      const discovery = tc.draw(gs.sampledFrom(DISCOVERY));
      expect(inspectBashCommand(`${prefix} cat ${discovery}`)).toBeDefined();
      expect(inspectBashCommand(`${prefix} cat notes.txt`)).toBeUndefined();
      expect(inspectBashCommand(`${prefix} printf '%s' ${discovery}`)).toBeUndefined();
      expect(inspectBashCommand(`cat <<'DOC'\n${prefix} cat ${discovery}\nDOC`)).toBeUndefined();
    })
      .settings(propertySettings(200))
      .runSync();
  });
});
