import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { stripSynchronizedOutput, synchronizedOutputStripper } from "./synchronized-output.ts";

const BEGIN = "\u001B[?2026h";
const END = "\u001B[?2026l";

void describe("synchronized output stripper", () => {
  void it("removes begin and end markers and keeps everything else", () => {
    const stripper = synchronizedOutputStripper();

    assert.equal(stripper.strip(`${BEGIN}\u001B[2Jframe${END}after`), "\u001B[2Jframeafter");
    assert.equal(stripper.flush(), "");
  });

  void it("removes a marker split across two writes", () => {
    const stripper = synchronizedOutputStripper();

    assert.equal(stripper.strip(`frame${END.slice(0, 4)}`), "frame");
    assert.equal(stripper.strip(`${END.slice(4)}next`), "next");
  });

  void it("releases a held prefix that never becomes a marker", () => {
    const stripper = synchronizedOutputStripper();

    assert.equal(stripper.strip("text\u001B[?20"), "text");
    assert.equal(stripper.strip("25h"), "\u001B[?2025h");
    assert.equal(stripper.strip("tail\u001B"), "tail");
    assert.equal(stripper.flush(), "\u001B");
  });

  void it("leaves other private modes untouched", () => {
    const stripper = synchronizedOutputStripper();

    assert.equal(stripper.strip("\u001B[?25l\u001B[?2004h"), "\u001B[?25l\u001B[?2004h");
  });
});

void describe("stripSynchronizedOutput", () => {
  void it("writes stripped strings, passes bytes through in order and flushes a trailing prefix", async () => {
    const written: Array<Uint8Array | string> = [];

    const stream = {
      write: (chunk: Uint8Array | string): boolean => {
        written.push(chunk);

        return true;
      },
    };

    stripSynchronizedOutput(stream);
    stream.write(`${BEGIN}a${END}\u001B[`);
    stream.write(Buffer.from("b"));
    stream.write("c\u001B");
    await nextTurn();

    assert.deepEqual(
      written.map((chunk) => (typeof chunk === "string" ? chunk : `bytes:${chunk.toString()}`)),
      ["a", "\u001B[", "bytes:b", "c", "\u001B"],
    );
  });
});
