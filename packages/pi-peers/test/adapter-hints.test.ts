import { describe, expect, test } from "vitest";
import { sendHint } from "../adapter/hints.js";
import type { SendOutcome } from "../adapter/send.js";

type Refused = Extract<SendOutcome, { tag: "not_admitted" }>;
type Unsure = Extract<SendOutcome, { tag: "unknown" }>;
type Resource = Extract<Refused, { code: "overloaded" }>["resource"];
const refusedCodes = Object.keys({
  forbidden: true,
  unavailable: true,
  no_route: true,
  id_conflict: true,
  invalid_correlation: true,
  delivery_too_large: true,
  protocol_error: true,
  cancelled: true,
  overloaded: true,
} satisfies Record<Refused["code"], true>);
const unsureCodes = Object.keys({
  unavailable: true,
  protocol_error: true,
  cancelled: true,
} satisfies Record<Unsure["code"], true>);
const resources = Object.keys({
  registrations: true,
  inbox: true,
  receipts: true,
  relations: true,
  interests: true,
  publications: true,
  operations: true,
  buffers: true,
  watch: true,
} satisfies Record<Resource, true>);

describe("send hints say what happened to the message", () => {
  test.each(refusedCodes)(
    "a %s refusal says not delivered, never that it may have arrived",
    (code) => {
      const hint = sendHint({ tag: "not_admitted", code });
      expect(hint).toMatch(/^Not delivered\./u);
      expect(hint).not.toMatch(/may have arrived/u);
    },
  );
  test.each(resources)("an overloaded %s refusal says not delivered", (resource) => {
    const hint = sendHint({ tag: "not_admitted", code: "overloaded", resource });
    expect(hint).toMatch(/^Not delivered\./u);
    expect(hint).not.toMatch(/may have arrived/u);
  });
  test.each(unsureCodes)(
    "an unknown (%s) outcome says it may have arrived and not to resend",
    (code) => {
      const hint = sendHint({ tag: "unknown", code });
      expect(hint).toMatch(/^It may have arrived\./u);
      expect(hint).toMatch(/Do not send it/u);
      expect(hint).toMatch(/retryOf/u);
    },
  );
  test("only a missing route says sending again cannot duplicate the message", () => {
    const safe = refusedCodes.filter((code) =>
      /cannot duplicate/u.test(sendHint({ tag: "not_admitted", code })),
    );
    expect(safe).toStrictEqual(["no_route"]);
  });
});
