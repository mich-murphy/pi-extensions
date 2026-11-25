import { Result, Schema } from "effect";

export class EmptyHtmlDocument extends Schema.TaggedError<EmptyHtmlDocument>()(
  "EmptyHtmlDocument",
  {},
) {
  override get message(): string {
    return "The page has no HTML content. It may need JavaScript to render; try another source.";
  }
}

export class HtmlConversionFailed extends Schema.TaggedError<HtmlConversionFailed>()(
  "HtmlConversionFailed",
  {
    cause: Schema.instanceOf(RangeError),
  },
) {
  override get message(): string {
    return "The page's HTML is too deeply nested to convert. Try format `html` for the raw source.";
  }
}

export type HtmlConversionError = EmptyHtmlDocument | HtmlConversionFailed;

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
