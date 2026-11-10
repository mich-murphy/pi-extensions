import { Hegel } from "@hegeldev/hegel";
import type { TestCase } from "@hegeldev/hegel";
import { propertySettings } from "../../../test-support/hegel-settings";

const settings = propertySettings(200);

/** Runs a Hegel property; the name matches the oxlint `assert*` convention so tests count as asserting. */
export function assertProperty(group: string, name: string, body: (tc: TestCase) => void): void {
  new Hegel(body).settings(settings).runSync();
}
