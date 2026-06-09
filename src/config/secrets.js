const config = require("./env");
module.exports = {
  resolveSecretValue: config.resolveSecretValue,
  resolveSecretPath: config.resolveSecretPath,
  normalizedSecretName: config.normalizedSecretName,
  redactSecrets: config.redactSecrets,
  buildHarnessEnv: config.buildHarnessEnv,
};
