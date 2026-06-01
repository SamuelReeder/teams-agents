const spawn = require("./spawn");
module.exports = {
  extractFlags: spawn.extractFlags,
  buildHarnessArgs: spawn.buildHarnessArgs,
  prepareHarnessArgs: spawn.prepareHarnessArgs,
  applyStickyOptions: spawn.applyStickyOptions,
  normalizeBareModel: spawn.normalizeBareModel,
  defaultModelForPrompt: spawn.defaultModelForPrompt,
};
