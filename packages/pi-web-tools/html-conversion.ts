import { Data, Result } from "effect";

/**
 * The document has no elements to convert: the body was empty, whitespace, comments, or bare text,
 * so the parser produced no document element.
 */
export class EmptyHtmlDocument extends Data.TaggedError("EmptyHtmlDocument") {
  /** Safe user-facing description. */
  override get message(): string {
    return "The page has no HTML content";
  }
}

/**
 * A conversion library (turndown or html-to-text) threw a RangeError, in practice a stack overflow
 * on very deeply nested markup. Other exceptions are defects and propagate.
 */
export class HtmlConversionFailed extends Data.TaggedError("HtmlConversionFailed")<{
  /** The RangeError, kept for local diagnosis only. */
  readonly cause: RangeError;
}> {
  /** Safe user-facing description; never includes the cause. */
  override get message(): string {
    return "Could not convert the page's HTML: it is too deeply nested";
  }
}

/** Expected failures converting fetched HTML. */
export type HtmlConversionError = EmptyHtmlDocument | HtmlConversionFailed;

/**
 * Run a turndown or html-to-text conversion, classifying only RangeError (stack overflow on deeply
 * nested markup inside the libraries) as HtmlConversionFailed.
 *
 * @param convert - The library conversion to run.
 * @returns The converted text, or HtmlConversionFailed for a RangeError.
 * @throws Any other exception unchanged: it is a defect, not a conversion failure.
 */
export function convertGuarded(convert: () => string): Result.Result<string, HtmlConversionFailed> {
  try {
    return Result.succeed(convert());
  } catch (cause) {
    if (cause instanceof RangeError) {
      return Result.fail(new HtmlConversionFailed({ cause }));
    }
    throw cause;
  }
}
