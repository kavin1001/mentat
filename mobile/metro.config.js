// The app shares code with the rest of the repo: the sync protocol (packages/sync-core) and the
// desktop's data types and formatters (src/shared). Metro needs to watch those folders and resolve
// their imports from this app's node_modules.
const path = require('path')
const { getDefaultConfig } = require('expo/metro-config')

const root = path.resolve(__dirname, '..')
const config = getDefaultConfig(__dirname)
config.watchFolders = [path.join(root, 'packages/sync-core'), path.join(root, 'src/shared')]
config.resolver.nodeModulesPaths = [path.join(__dirname, 'node_modules')]
module.exports = config
