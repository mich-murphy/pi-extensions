import { describe, expect, test } from "vitest";
import { CredentialFailure } from "../credentials";
import { UnsupportedBinaryContent } from "../fetch-page";
import { HttpStatusRejected } from "../network";

describe("safe, actionable web errors", () => {
  test.each([
    [401, "requires authentication", "public page"],
    [404, "could not find", "Check the URL"],
  ] as const)(
    "keeps HTTP %s as an external failure with a next action",
    (status, cause, action) => {
      const error = new HttpStatusRejected({
        status,
        statusText: `https://user:password@example.com/?token=secret\u001b[2J\u202e${"x".repeat(5000)}`,
      });
      expect(error._tag).toBe("HttpStatusRejected");
      expect(error.status).toBe(status);
      expect(error.message).toContain(String(status));
      expect(error.message).toContain(cause);
      expect(error.message).toContain(action);
      expect(error.message).not.toMatch(/password|secret|\p{Cc}|\p{Bidi_Control}/u);
      expect(error.message.length).toBeLessThan(400);
    },
  );

  test("does not reflect arbitrary remote status text for other HTTP errors", () => {
    const error = new HttpStatusRejected({ status: 503, statusText: "secret\u001b[2J" });
    expect(error.message).toBe("Request failed (503 Service Unavailable)");
    expect(error.statusText).toBe("secret\u001b[2J");
  });

  test("explains the PDF conversion limit without suggesting retries", () => {
    const error = new UnsupportedBinaryContent({ mime: "application/pdf" });
    expect(error._tag).toBe("UnsupportedBinaryContent");
    expect(error.message).toContain("cannot extract PDF text");
    expect(error.message).toContain("HTML/text version");
    expect(error.message).toContain("retrying the same PDF will not convert it");
  });

  test("does not reflect unrecognized Content-Type values", () => {
    const error = new UnsupportedBinaryContent({
      mime: `application/secret-https://user:password@example.com/\u001b[2J${"x".repeat(5000)}`,
    });
    expect(error.message).toBe("Unsupported binary content. Try a more text-oriented URL.");
  });

  test.each(["unavailable", "resolution", "invalid", "timeout", "incompatible"] as const)(
    "keeps credential category %s while explaining recovery",
    (reason) => {
      const error = new CredentialFailure({ provider: "exa", reason });
      expect(error._tag).toBe("CredentialFailure");
      expect(error.reason).toBe(reason);
      expect(error.message).toContain(`credential ${reason}:`);
      expect(error.message).toMatch(/Check|check/u);
      expect(error.message.length).toBeLessThan(250);
    },
  );
});
