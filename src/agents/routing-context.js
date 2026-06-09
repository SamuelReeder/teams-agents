const spawn = require("./spawn");
module.exports = {
  buildRoutingContext: spawn.buildRoutingContext,
  buildPromptWithExecutionContext: spawn.buildPromptWithExecutionContext,
  promptNeedsAlola: spawn.promptNeedsAlola,
};
