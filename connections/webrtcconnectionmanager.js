'use strict';

const WebRtcConnection = require('./webrtcconnection');

class WebRtcConnectionManager
{
    constructor(options = {})
    {
        options = {
            Connection: WebRtcConnection,
            ...options
        };
		const { Connection } = options;
		const connections = new Map();
		const closedListeners = new Map();

		function deleteConnection(connection) {
			// 1. Remove "closed" listener.
			const closedListener = closedListeners.get(connection);
			closedListeners.delete(connection);
			connection.removeListener("closed", closedListener);

			// 2. Remove the Connection from the Map.
			connections.delete(connection.id);
		}
        
        this.createConnection = async (clientID,connectionStateChangedcb) =>
        {
			options.sendConfigMessage=this.sendConfigMessage;
            const connection = new Connection(clientID,options);
            connection.connectionStateChanged=connectionStateChangedcb;
            // 1. Add the "closed" listener.
            function closedListener() { deleteConnection(connection); }
            closedListeners.set(connection, closedListener);
            connection.once('closed', closedListener);

            // 2. Add the Connection to the Map.
            connections.set(connection.id, connection);

            await connection.doOffer();
            return connection;
        };

        this.getConnection = id =>
        {
            return connections.get(id) || null;
        };

        this.getConnections = () =>
        {
            return [...connections.values()];
        };
    }

    toJSON ()
    {
        return this.getConnections().map(connection => connection.toJSON());
    }
	SetSendConfigMessage(cfm)
	{
		this.sendConfigMessage=cfm;
	}
}

WebRtcConnectionManager.create = function create (options)
{
    return new WebRtcConnectionManager({
        Connection: function (id)
        {
            return new WebRtcConnection(id,options);
        },
        ...options
    });
};

WebRtcConnectionManager.getInstance = function(){
	if(global.WebRtcConnectionManager_instance === undefined)
	  global.WebRtcConnectionManager_instance = new WebRtcConnectionManager();
	return global.WebRtcConnectionManager_instance;
  }

module.exports = WebRtcConnectionManager;
