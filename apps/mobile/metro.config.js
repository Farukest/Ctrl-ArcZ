// Metro config for the pnpm monorepo. Metro must watch the workspace root (so it
// bundles @ctrl-arcz/sdk from packages/), resolve modules from both the app and
// the root node_modules, and follow pnpm's symlinks.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];
// pnpm stores each package's own deps as siblings under its .pnpm folder, so
// Metro MUST keep hierarchical lookup on (the default) to resolve a package's
// transitive deps (e.g. react-native-get-random-values -> fast-base64-decode).
// Disabling it, as hoisted (npm/yarn) monorepos do, breaks pnpm resolution.
config.resolver.disableHierarchicalLookup = false;
config.resolver.unstable_enableSymlinks = true;

module.exports = config;
