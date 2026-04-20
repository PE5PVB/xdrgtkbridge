// Plugin configuration, this is used in the administration when plugins are loaded
var pluginConfig = {
    name: 'XDR-GTK Bridge',
    version: '1.0',
    author: 'OpenRadio',
    frontEndPath: 'xdrgtk_bridge/frontend.js'
}

// Backend (server) logic lives in xdrgtk_bridge/frontend_server.js

// Don't change anything below here if you are making your own plugin
module.exports = {
    pluginConfig
}
