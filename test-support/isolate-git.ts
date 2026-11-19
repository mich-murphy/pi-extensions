/**
 * Git runs hooks with `GIT_DIR`, `GIT_INDEX_FILE` and similar variables naming the repository being
 * committed or pushed. A test that spawns git in a fixture repository inherits them, so its `init`,
 * `config` and `commit` act on that repository instead. Removing them before any test runs keeps
 * fixtures inside their own directories.
 */
for (const name of Object.keys(process.env)) {
  if (name.startsWith("GIT_")) {
    Reflect.deleteProperty(process.env, name);
  }
}
