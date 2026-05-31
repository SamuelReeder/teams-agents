const config = require("./env");
module.exports = {
  loadChannels: config.loadChannels,
  validateChannels: config.validateChannels,
  resolveChannelsFile: config.resolveChannelsFile,
  resetChannelsForTests: config.resetChannelsForTests,
};
