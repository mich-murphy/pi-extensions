import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

export const FEEDBACK_OUTPUT = Type.Object({
  status: StringEnum(["recorded", "duplicate", "limit", "off", "failed"] as const, {
    description: "What happened to the report.",
  }),
  group: Type.Optional(Type.String({ description: "The group the report joined, when recorded." })),
  owner: Type.Optional(Type.String({ description: "The report's owner, when recorded." })),
});
