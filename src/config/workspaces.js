const config = require("./env");
module.exports = {
  resolveWorkspace: config.resolveWorkspace,
  workspaceFromPersisted: config.workspaceFromPersisted,
  workspaceIdForDir: config.workspaceIdForDir,
  attachWorkspace: config.attachWorkspace,
};
