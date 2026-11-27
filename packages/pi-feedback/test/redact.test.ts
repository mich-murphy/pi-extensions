import { describe, expect, test } from "vitest";
import { REDACTED, redact } from "../redact.ts";

describe("redact", () => {
  test.each([
    ["an Anthropic key", `key sk-ant-${"a".repeat(32)} end`, `key ${REDACTED} end`],
    ["a GitHub token", `ghp_${"b".repeat(36)}`, REDACTED],
    ["a fine-grained GitHub token", `github_pat_${"c".repeat(40)}`, REDACTED],
    ["a Slack token", "xoxb-1234567890-abcdef", REDACTED],
    ["an AWS access key", "AKIAABCDEFGHIJKLMNOP", REDACTED],
    ["a JWT", "eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4", REDACTED],
  ])("removes %s", (_name, input, expected) => {
    expect(redact(input)).toBe(expected);
  });

  test("keeps the label of a bearer header", () => {
    expect(redact("Authorization: Bearer abcdefghijklmnop")).toBe(
      `Authorization: Bearer ${REDACTED}`,
    );
  });

  test("keeps the name of an assigned secret", () => {
    expect(redact('TYPESAFE_API_KEY="0123456789abcdef" next')).toBe(
      `TYPESAFE_API_KEY="${REDACTED}" next`,
    );
  });

  test.each([
    ["a short value before a semicolon", "password=hunter2;more", `password=${REDACTED}`],
    [
      "a short value before a semicolon and newline",
      " api_key=0000000;\n",
      ` api_key=${REDACTED};\n`,
    ],
    ["a value whose first segment has 8 characters", "token=abcdefgh;ijk", `token=${REDACTED}`],
    ["a value split by commas", 'secret: "ab,cdefghij"', `secret: "${REDACTED}"`],
  ])("removes all of %s", (_name, input, expected) => {
    expect(redact(input)).toBe(expected);
  });

  test("keeps punctuation after an assigned secret", () => {
    expect(redact("token=abcdefghij, next; then")).toBe(`token=${REDACTED}, next; then`);
  });

  test("removes a private key block", () => {
    const key = "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\ndef\n-----END OPENSSH PRIVATE KEY-----";
    expect(redact(`before ${key} after`)).toBe(`before ${REDACTED} after`);
  });

  test("leaves ordinary error text alone", () => {
    const text = "ENOENT: no such file or directory, access '/tmp/x/token.txt'";
    expect(redact(text)).toBe(text);
  });

  test.each([
    ["password=hunter2", `password=${REDACTED}`],
    ["export DB_PASSWORD=hunter2", `export DB_PASSWORD=${REDACTED}`],
    ["PGPASSWORD=x psql", `PGPASSWORD=${REDACTED} psql`],
    ["password: hunter2", `password: ${REDACTED}`],
    ["  db_password: 'hunter2'\n  host: db", `  db_password: '${REDACTED}'\n  host: db`],
    ['{"password":"hunter2","user":"bob"}', `{"password":"${REDACTED}","user":"bob"}`],
    ["mysql -u root --password=hunter2 db", `mysql -u root --password=${REDACTED} db`],
    ["mysql --password hunter2 db", `mysql --password ${REDACTED} db`],
    ["pwd=abc;Server=x", `pwd=${REDACTED}`],
    ["client_secret=abc123", `client_secret=${REDACTED}`],
    ["aws_secret_access_key = wJalr", `aws_secret_access_key = ${REDACTED}`],
    ["private_key: abc", `private_key: ${REDACTED}`],
    ["SESSION_ID=a1b2", `SESSION_ID=${REDACTED}`],
    ["credentials=u:p", `credentials=${REDACTED}`],
    ["MYSQL_PWD=pw mysql", `MYSQL_PWD=${REDACTED} mysql`],
    ["token := abc", `token := ${REDACTED}`],
    ["password=changeme", `password=${REDACTED}`],
    ["Authorization: Basic dXNlcjpwYXNz", `Authorization: Basic ${REDACTED}`],
    ["Authorization: Bearer abc", `Authorization: Bearer ${REDACTED}`],
    ["Proxy-Authorization: xyz", `Proxy-Authorization: ${REDACTED}`],
    ['curl -H "Authorization: token abc" x', `curl -H "Authorization: token ${REDACTED}" x`],
    ["Cookie: sid=abc; theme=dark", `Cookie: ${REDACTED}`],
    ["Set-Cookie: sid=abc; Path=/\nnext", `Set-Cookie: ${REDACTED}\nnext`],
    [
      "psql postgres://admin:s3cret@db.example.com/app",
      `psql postgres://admin:${REDACTED}@db.example.com/app`,
    ],
    ["curl -u admin:hunter2 https://x", `curl -u admin:${REDACTED} https://x`],
    ["curl --user admin:hunter2 https://x", `curl --user admin:${REDACTED} https://x`],
    [
      "git clone https://x-access-token:abc@github.com/o/r",
      `git clone https://x-access-token:${REDACTED}@github.com/o/r`,
    ],
    [`AIza${"A".repeat(35)}`, REDACTED],
    ["npm_abcdefghijklmnopqrstuvwxyz0123456789", REDACTED],
    ["sk_live_abcdefghij1234", REDACTED],
    ["rk_test_abcdefghij1234", REDACTED],
    ["glpat-aaaaaaaaaaaaaaaaaaaa", REDACTED],
    [`hf_${"a".repeat(34)}`, REDACTED],
    ["ASIAABCDEFGHIJKLMNOP", REDACTED],
    [`sk-svcacct-${"a".repeat(24)}`, REDACTED],
    [`sk-admin-${"a".repeat(24)}`, REDACTED],
    [`sk-ant-admin01-${"a".repeat(24)}`, REDACTED],
    ["xoxe-1-abcdefghijkl", REDACTED],
    [
      "post https://hooks.slack.com/services/T0000/B0000/abcdefghij failed",
      `post ${REDACTED} failed`,
    ],
  ])("removes the secret in %j", (input, expected) => {
    expect(redact(input)).toBe(expected);
  });

  test.each([
    [
      { path: ".env", content: 'API_KEY="abcdefghijkl1234"\nPORT=1' },
      { path: ".env", content: `API_KEY="${REDACTED}"\nPORT=1` },
    ],
    [
      { path: ".env", content: "DB_PASSWORD=hunter2\nPORT=5432" },
      { path: ".env", content: `DB_PASSWORD=${REDACTED}\nPORT=5432` },
    ],
    [
      { command: 'mysql -u root --password="hunter2secret" db' },
      { command: `mysql -u root --password="${REDACTED}" db` },
    ],
    [
      { headers: { Authorization: "Bearer x", "X-Api-Key": "k1" }, password: "pw" },
      {
        headers: { Authorization: `Bearer ${REDACTED}`, "X-Api-Key": REDACTED },
        password: REDACTED,
      },
    ],
  ])("removes the secret from stringified arguments %j", (input, expected) => {
    expect(redact(JSON.stringify(input))).toBe(JSON.stringify(expected));
  });

  test.each([
    "token: see docs",
    "the password: is wrong",
    "the password is hunter2",
    "Error: invalid token: expected 40 chars",
    "password: hunter2 and more",
    "passwordless=true",
    "max_tokens=4096",
    "token_count=12",
    "author=jane",
    "auth_type=basic",
    "secret_name=prod-db",
    "api_key_file=/run/key",
    "public_key=abc",
    "password == expected",
    "api_key=${API_KEY}",
    'API_KEY="<your-key>"',
    "API_KEY=your-api-key",
    "secret=***",
    "secret=xxx",
    "password=...",
    "token=$GITHUB_TOKEN",
    "token=%TOKEN%",
    "token={{ token }}",
    "api_key=process.env.API_KEY",
    "secret=os.environ['X']",
    "password=null",
    "password=[Filtered]",
    `password=${REDACTED}`,
    "mysql --password --host db",
    "ENOENT: no such file or directory, access '/tmp/x/token.txt'",
    "see https://example.com/a:b@c",
  ])("keeps %j", (text) => {
    expect(redact(text)).toBe(text);
  });
});
