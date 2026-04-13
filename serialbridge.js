// Plugin configuration, this is used in the administration when plugins are loaded
var pluginConfig = {
    name: 'Serial Bridge',
    version: '1.0',
    author: 'OpenRadio',
    frontEndPath: 'serialbridge/frontend.js'
}

// Backend (server) logic lives in serialbridge_server.js

// Don't change anything below here if you are making your own plugin
module.exports = {
    pluginConfig
}
