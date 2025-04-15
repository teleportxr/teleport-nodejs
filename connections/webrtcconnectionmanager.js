'use strict';

const WebRtcConnection = require('./webrtcconnection');

class WebRtcConnectionManager
{
    constructor(options = {})
    {
		this.connections = new Map();
		this.closedListeners = new Map();
		this.options=options;
    }

	deleteConnection(connection)
	{
		console.log("deleteConnection "+connection.clientID);
			// 1. Remove "closed" listener?
		//const closedListener = this.closedListeners.get(connection);
			//connection.removeListener("closed", closedListener);
		//this.closedListeners.delete(connection);

		// 2. Remove the WebRtcConnection from the Map.
		this.connections.delete(connection.id);
	}
	getConnection(id)
	{
		return this.connections.get(id) || null;
	}

	getConnections()
	{
		return [...this.connections.values()];
	};

        
	closedListener()
	{
		this.deleteConnection(connection);
	}
	createConnection(clientID,connectionStateChangedcb,messageReceivedReliableCb,messageReceivedUnreliableCb)
	{
		var options=this.options;
		options.sendConfigMessage	=this.sendConfigMessage;
        
		options.messageReceivedReliable		=messageReceivedReliableCb;
		options.messageReceivedUnreliable	=messageReceivedUnreliableCb;
		options.connectionStateChanged		=connectionStateChangedCb;
        const connection = new WebRtcConnection(clientID,options);
        //  We will not add a "closed" listener, because only the client object will be permitted to close its connection.
		//this.createConnection = (clientID) => this.closedListeners.set(connection, this.closedListener);
        //connection.once('closed', this.closedListener);

        // 2. Add the WebRtcConnection to the Map.
        this.connections.set(connection.id, connection);

            connection.doOffer();
            return connection;
        };
	destroyConnection(clientID)
        {
		var connection=this.connections.get(clientID);
		if(connection)
        {
			connection.close();
			this.connections.delete(clientID);
    }
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
        WebRtcConnection: function (id)
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
