import { Result, Schema } from "effect";
import TurndownService from "turndown";
import { afterEach, assert, describe, expect, test, vi } from "vitest";
import * as Html from "../html";
import { convertGuarded, HtmlConversionFailed } from "../html-conversion";

const OVERFLOW = new RangeError("Maximum call stack size exceeded");

describe("a library stack overflow", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("is HtmlConversionFailed carrying the RangeError", () => {
    const converted = convertGuarded(() => {
      throw OVERFLOW;
    });

    assert(Result.isFailure(converted));
    assert(Schema.is(HtmlConversionFailed)(converted.failure));
    expect(converted.failure.cause).toBe(OVERFLOW);
  });

  test("any other exception propagates unchanged", () => {
    const defect = new TypeError("not a stack overflow");
    expect(() =>
      convertGuarded(() => {
        throw defect;
      }),
    ).toThrow(defect);
  });

  test("inside turndown is reported by htmlToMarkdown as HtmlConversionFailed", () => {
    vi.spyOn(TurndownService.prototype, "turndown").mockImplementation(() => {
      throw OVERFLOW;
    });
    const converted = Html.htmlToMarkdown("<p>hello</p>", "https://example.com");
    assert(Result.isFailure(converted));
    assert(Schema.is(HtmlConversionFailed)(converted.failure));
    expect(converted.failure.cause).toBe(OVERFLOW);
  });
});
