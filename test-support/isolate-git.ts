for (const name of Object.keys(process.env)) {
  if (name.startsWith("GIT_")) {
    Reflect.deleteProperty(process.env, name);
  }
}
