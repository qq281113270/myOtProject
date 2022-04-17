var emitter = require('../emitter');
var Doc = require('./doc');

// 如果状态等于 0 或者 1 那么 就是在连接中
function connectionState(socket) {
    if (socket.readyState === 0 || socket.readyState === 1) return 'connecting';
    return 'disconnected';
}

/**
 * Handles communication with the sharejs server and provides queries and
 * documents.
 *
 * We create a connection with a socket object
 *   connection = new sharejs.Connection(sockset)
 * The socket may be any object handling the websocket protocol. See the
 * documentation of bindToSocket() for details. We then wait for the connection
 * to connect
 *   connection.on('connected', ...)
 * and are finally able to work with shared documents
 *   connection.get('food', 'steak') // Doc
 *
 * @param socket @see bindToSocket
*处理与sharejs服务器的通信，并提供查询和
*文档。
＊
通过socket对象创建一个连接
 */
module.exports = Connection;
// 构造函数
function Connection(
    socket //socket对象
) {
    // 引入 events 模块 发布订阅事件
    emitter.EventEmitter.call(this);

    // Map of collection -> id -> doc object for created documents.
    // (created documents MUST BE UNIQUE)
    //集合的映射-> id ->文档对象创建的文档。
    //创建的文档必须是唯一的
    this.collections = {};

    // Each query and snapshot request is created with an id that the server uses when it sends us
    // info about the request (updates, etc)
    //每个查询和快照请求都创建了一个id，当服务器发送给我们时使用这个id
    //请求的信息(更新等)
    this.nextQueryId = 1;
    this.nextSnapshotRequestId = 1;

    // Map from query ID -> query object.
    //从查询ID ->查询对象映射。
    this.queries = {};

    // Maps from channel -> presence objects
    //从channel ->存在对象映射
    this._presences = {};

    // Map from snapshot request ID -> snapshot request
    //映射快照请求ID ->快照请求
    this._snapshotRequests = {};

    // A unique message number for the given id
    //给定id的唯一消息号
    this.seq = 1;

    // A unique message number for presence
    this._presenceSeq = 1;

    // Equals agent.src on the server
    this.id = null;

    // This direct reference from connection to agent is not used internal to
    // ShareDB, but it is handy for server-side only user code that may cache
    // state on the agent and read it in middleware
    this.agent = null;

    this.debug = false;
    //获取连接状态 如果状态等于 0 或者 1 那么 就是在连接中
    this.state = connectionState(socket);

    this.bindToSocket(socket);
}
emitter.mixin(Connection);

/**
 * Use socket to communicate with server
 *
 * Socket is an object that can handle the websocket protocol. This method
 * installs the onopen, onclose, onmessage and onerror handlers on the socket to
 * handle communication and sends messages by calling socket.send(message). The
 * sockets `readyState` property is used to determine the initaial state.
 *
 * @param socket Handles the websocket protocol
 * @param socket.readyState
 * @param socket.close
 * @param socket.send
 * @param socket.onopen
 * @param socket.onclose
 * @param socket.onmessage
 * @param socket.onerror
 */
// 绑定 Socket
Connection.prototype.bindToSocket = function (socket) {
    if (this.socket) {
        // 关闭连接
        this.socket.close();
        this.socket.onmessage = null;
        this.socket.onopen = null;
        this.socket.onerror = null;
        this.socket.onclose = null;
    }

    this.socket = socket;

    // State of the connection. The corresponding events are emitted when this changes
    //
    // - 'connecting'   The connection is still being established, or we are still
    //                    waiting on the server to send us the initialization message
    // - 'connected'    The connection is open and we have connected to a server
    //                    and recieved the initialization message
    // - 'disconnected' Connection is closed, but it will reconnect automatically
    // - 'closed'       The connection was closed by the client, and will not reconnect
    // - 'stopped'      The connection was closed by the server, and will not reconnect
    // 获取最新的状态
    var newState = connectionState(socket);
    // 设置socket状态
    this._setState(newState);

    // This is a helper variable the document uses to see whether we're
    // currently in a 'live' state. It is true if and only if we're connected
    this.canSend = false;

    var connection = this;
    // 获取socket消息
    socket.onmessage = function (event) {
        console.log('接收到服务器消息=', event);
        try {
            var data =
                typeof event.data === 'string'
                    ? JSON.parse(event.data)
                    : event.data;
        } catch (err) {
            console.warn('Failed to parse message', event);
            return;
        }

        if (connection.debug) {
            console.info('RECV', JSON.stringify(data));
        }

        var request = { data: data };
        connection.emit('receive', request);
        if (!request.data) return;

        try {
            // 处理服务器消息
            connection.handleMessage(request.data);
        } catch (err) {
            util.nextTick(function () {
                connection.emit('error', err);
            });
        }
    };

    // If socket is already open, do handshake immediately. //如果socket已经打开，立即握手。
    // 如果socket已经打开，则先发一个 hs 给服务器
    if (socket.readyState === 1) {
        // debugger;
        connection._initializeHandshake();
    }

    // socket 已经连接上
    socket.onopen = function () {
        console.log('客户端 socket 已经连接上');

        // 设置状态
        connection._setState('connecting');

        connection._initializeHandshake();
    };

    socket.onerror = function (err) {
        // This isn't the same as a regular error, because it will happen normally
        // from time to time. Your connection should probably automatically
        // reconnect anyway, but that should be triggered off onclose not onerror.
        // (onclose happens when onerror gets called anyway).
        connection.emit('connection error', err);
    };

    socket.onclose = function (reason) {
        // node-browserchannel reason values:
        //   'Closed' - The socket was manually closed by calling socket.close()
        //   'Stopped by server' - The server sent the stop message to tell the client not to try connecting
        //   'Request failed' - Server didn't respond to request (temporary, usually offline)
        //   'Unknown session ID' - Server session for client is missing (temporary, will immediately reestablish)

        if (reason === 'closed' || reason === 'Closed') {
            connection._setState('closed', reason);
        } else if (reason === 'stopped' || reason === 'Stopped by server') {
            connection._setState('stopped', reason);
        } else {
            connection._setState('disconnected', reason);
        }
    };
};

// 集合 collection 和 文档 id
Connection.prototype.get = function (
    collection, //collections 集合key
    id //文档id 集合key
) {
    var docs =
        this.collections[collection] || (this.collections[collection] = {});

    var doc = docs[id];
    // 如果文档不存在则创建一个文档
    if (!doc) {
        doc = docs[id] = new Doc(this, collection, id);
        this.emit('doc', doc);
    }

    return doc;
};

// Set the connection's state. The connection is basically a state machine. 设置连接的状态。连接基本上是一个状态机。
Connection.prototype._setState = function (newState, reason) {
    if (this.state === newState) return;

    // I made a state diagram. The only invalid transitions are getting to
    // 'connecting' from anywhere other than 'disconnected' and getting to
    // 'connected' from anywhere other than 'connecting'.
    if (
        (newState === 'connecting' &&
            this.state !== 'disconnected' &&
            this.state !== 'stopped' &&
            this.state !== 'closed') ||
        (newState === 'connected' && this.state !== 'connecting')
    ) {
        return this.emit('error', err);
    }

    this.state = newState;
    this.canSend = newState === 'connected';

    if (
        newState === 'disconnected' ||
        newState === 'stopped' ||
        newState === 'closed'
    ) {
        this._reset();
    }

    // Group subscribes together to help server make more efficient calls 分组订阅可以帮助服务器进行更高效的呼叫
    this.startBulk();
    // Emit the event to all queries
    for (var id in this.queries) {
        var query = this.queries[id];
        query._onConnectionStateChanged();
    }
    // Emit the event to all documents
    for (var collection in this.collections) {
        var docs = this.collections[collection];
        for (var id in docs) {
            docs[id]._onConnectionStateChanged();
        }
    }
    // Emit the event to all Presences
    for (var channel in this._presences) {
        this._presences[channel]._onConnectionStateChanged();
    }
    // Emit the event to all snapshots
    for (var id in this._snapshotRequests) {
        var snapshotRequest = this._snapshotRequests[id];
        snapshotRequest._onConnectionStateChanged();
    }
    this.endBulk();

    this.emit(newState, reason);
    this.emit('state', newState, reason);
};

// 发送{ a: "hs", id: this.id }给服务器  连上 socket 的时候先发送一个hs给服务器
Connection.prototype._initializeHandshake = function () {
    // 发送 消息
    console.info('发送消息给服务端', { a: 'hs', id: this.id });
    this.send({ a: 'hs', id: this.id });
};

/**
 * Sends a message down the socket 向套接字发送消息
 */
Connection.prototype.send = function (message) {
    this.emit('send', message);
    // 发送消息
    this.socket.send(JSON.stringify(message));
};

/**
 * @param {object} message
 * @param {string} message.a action
 */
// websocket 响应信息
Connection.prototype.handleMessage = function (message) {
    // console.log('message1=', message);
    debugger;
    var err = null;
    if (message.error) {
        err = wrapErrorData(message.error, message);
        delete message.error;
    }
    // Switch on the message action. Most messages are for documents and are
    // handled in the doc class.
    //打开消息动作。大多数消息都是用于文档的
    //在doc类中处理。
    switch (message.a) {
        case 'init':
            // Client initialization packet
            // 初始化 获取到服务器init 信息的时候  会推送"hs" 给服务器
            // 初始化告诉服务器 客户端已经连上   设置已经连上状态
            return this._handleLegacyInit(message);
        case 'hs':
            // 设置已经连上状态 告诉服务器 客户端socket已经连上
            return this._handleHandshake(err, message);
        case 'qf':
            var query = this.queries[message.id];
            if (query) query._handleFetch(err, message.data, message.extra);
            return;
        case 'qs':
            var query = this.queries[message.id];
            if (query) query._handleSubscribe(err, message.data, message.extra);
            return;
        case 'qu':
            // Queries are removed immediately on calls to destroy, so we ignore
            // replies to query unsubscribes. Perhaps there should be a callback for
            // destroy, but this is currently unimplemented
            return;
        case 'q':
            // Query message. Pass this to the appropriate query object.
            var query = this.queries[message.id];
            if (!query) return;
            if (err) return query._handleError(err);
            if (message.diff) query._handleDiff(message.diff);
            if (message.hasOwnProperty('extra'))
                query._handleExtra(message.extra);
            return;

        case 'bf':
            return this._handleBulkMessage(err, message, '_handleFetch');
        case 'bs':
        case 'bu':
            return this._handleBulkMessage(err, message, '_handleSubscribe');

        case 'nf':
        case 'nt':
            return this._handleSnapshotFetch(err, message);

        case 'f':
            var doc = this.getExisting(message.c, message.d);
            if (doc) doc._handleFetch(err, message.data);
            return;
        case 's':
        case 'u':
            var doc = this.getExisting(message.c, message.d);
            if (doc) doc._handleSubscribe(err, message.data);
            return;
        case 'op':
            var doc = this.getExisting(message.c, message.d);
            if (doc) doc._handleOp(err, message);
            return;
        case 'p':
            return this._handlePresence(err, message);
        case 'ps':
            return this._handlePresenceSubscribe(err, message);
        case 'pu':
            return this._handlePresenceUnsubscribe(err, message);
        case 'pr':
            return this._handlePresenceRequest(err, message);

        default:
            logger.warn('Ignoring unrecognized message', message);
    }
};

// 初始化告诉服务器 客户端已经连上   设置已经连上状态
Connection.prototype._handleLegacyInit = function (message) {
    // If the minor protocol version has been set, we want to use the
    // new handshake protocol. Let's send a handshake initialize, because
    // we now know the server is ready. If we've already sent it, we'll
    // just ignore the response anyway.
    //如果已经设置了次要协议版本，我们希望使用
    //新建握手协议。让我们发送一个握手初始化，因为
    //我们现在知道服务器已经准备好了。如果我们已经发送了，我们会的
    //忽略响应。
    if (message.protocolMinor) {
        // 初始化告诉服务器 客户端已经连上
        return this._initializeHandshake();
    }
    // 设置已经连上状态
    this._initialize(message);
};

// 设置已经连上状态
Connection.prototype._initialize = function (message) {
    if (this.state !== 'connecting') return;

    this.id = message.id;

    this._setState('connected');
};
