import { Database, Hegel } from "@hegeldev/hegel";
import type { TestCase } from "@hegeldev/hegel";

const settings = { testCases: 200, seed: 12_345n, database: Database.disabled };

/** Runs a Hegel property; the name matches the oxlint `assert*` convention so tests count as asserting. */
export function assertProperty(group: string, name: string, body: (tc: TestCase) => void): void {
  new Hegel(body).databaseKey(`pi-skill-toggle/${group}/${name}`).settings(settings).runSync();
}
