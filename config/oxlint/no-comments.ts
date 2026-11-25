import type { RuleTester } from "oxlint/plugins-dev";

type Rule = Parameters<RuleTester["run"]>[1];

type Comment = { type: "Line" | "Block" | "Shebang"; value: string };

const toolDirective =
  /^\s*(?:(?:eslint|oxlint)-(?:disable|enable)(?:-next-line|-line)?\b|@ts-expect-error\b|prettier-ignore\b|oxfmt-ignore\b|fallow-ignore-|(?:v8|c8|istanbul) ignore\b|@vitest-environment\b)/u;

const tripleSlashReference = /^\/\s*<reference\s/u;
const licenseHeader = /SPDX-License-Identifier:|@license\b|\bCopyright\b/u;
const bareLink = /^https?:\/\/\S+$/u;
const suppressesThisRule = /^\s*(?:eslint|oxlint)-disable.*\bno-comments\b/u;
const needsReason = /^\s*(?:(?:eslint|oxlint)-disable(?:-next-line|-line)?\b|@ts-expect-error\b)/u;
const hasReason = /\s--\s+\S/u;
const blanketDisable = /^\s*(?:eslint|oxlint)-disable(?:-next-line|-line)?\s*(?:--|$)/u;
const assertionJustification = /^\s*(?:\*\s*)*(?:SAFETY|INVARIANT)\s*:/u;

const message =
  "Comments are banned: they go stale and agents copy them. Make the code say it instead: rename, extract a function, encode the constraint in a type, test or lint rule, fix the root cause of the workaround, or delete the comment. Allowed: lint/type/formatter directives, license headers, shebangs, triple-slash references, and a comment holding only an issue or RFC URL.";

const assertionJustificationMessage =
  "Assertion-justification comments are banned. Remove the type assertion with a Schema decode, `satisfies`, or a type annotation. If the assertion is unavoidable, put the checked invariant in this directive: `// oxlint-disable-next-line typescript/no-unsafe-type-assertion, anti-slop/require-safety-comment-for-type-assertion -- <checked invariant>`.";

const missingReasonMessage =
  "Suppressions need a reason: append ` -- <why this rule is wrong here>`. If the rule guards correctness or safety, fix the code instead of suppressing it.";

const blanketMessage =
  "Name the rules a suppression disables; a blanket disable would also silence pi-extensions/no-comments.";

const suppressionMessage =
  "Do not suppress pi-extensions/no-comments; express the point in code or replace the comment with a bare issue or RFC URL.";

function isAllowed(comment: Comment): boolean {
  if (comment.type === "Shebang") {
    return true;
  }

  return (
    toolDirective.test(comment.value) ||
    tripleSlashReference.test(comment.value) ||
    licenseHeader.test(comment.value) ||
    bareLink.test(comment.value.replace(/^\s*\*?/u, "").trim())
  );
}

const noComments = {
  meta: { type: "suggestion" },
  create(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          if (blanketDisable.test(comment.value)) {
            context.report({ message: blanketMessage, loc: comment.loc });
          } else if (suppressesThisRule.test(comment.value)) {
            context.report({ message: suppressionMessage, loc: comment.loc });
          } else if (needsReason.test(comment.value) && !hasReason.test(comment.value)) {
            context.report({ message: missingReasonMessage, loc: comment.loc });
          } else if (comment.type !== "Shebang" && assertionJustification.test(comment.value)) {
            context.report({ message: assertionJustificationMessage, loc: comment.loc });
          } else if (!isAllowed(comment)) {
            context.report({ message, loc: comment.loc });
          }
        }
      },
    };
  },
} satisfies Rule;

export default {
  meta: { name: "pi-extensions" },
  rules: { "no-comments": noComments },
};
