var emitter = require('./emitter');
var StreamSocket = require('./stream-socket');
var Connection = require('./client/connection');
var Agent = require('./agent');
var util = require('./util');








//获取应答错误对象
function getReplyErrorObject(err) {
    if (typeof err === 'string') {
        return {
            code: 400,
            message: err,
        };
    } else {
        if (err.stack) {
            console.info(err.stack);
        }
        return {
            code: err.code,
            message: err.message,
        };
    }
}


function Backend(options) {
    if (!(this instanceof Backend)) {
        return new Backend(options);
    }
    emitter.EventEmitter.call(this);

    if (!options) options = {};
}




// 获取连接文档
Backend.prototype.connect = function (connection, req, callback) {
    // 创建doc  socket  这个也是服务器模拟前端的socket
    var socket = new StreamSocket();
    if (connection) {
        connection.bindToSocket(socket);
    } else {
        connection = new Connection(socket);
    }
    // 告诉服务端模拟的客户端socket已经连上
    socket._open();
    // 监听服务端socket
    var agent = this.listen(socket.stream, req);
    // Store a reference to the agent on the connection for convenience. This is
    // not used internal to ShareDB, but it is handy for server-side only user
    // code that may cache state on the agent and read it in middleware
    connection.agent = agent;

    if (typeof callback === 'function') {
        connection.once('connected', function () {
            callback(connection);
        });
    }

    return connection;
};

Backend.prototype.listen = function (
    stream, //服务器模拟客户端的 websocket
    req // node req
) {
    //
    var agent = new Agent(this, stream);
    // this.trigger(
    //     this.MIDDLEWARE_ACTIONS.connect,
    //     agent,
    //     { stream: stream, req: req },
    //     function (err) {
    //         if (err) {
    //             return agent.close(err);
    //         }
    agent._open();
    //     }
    // );
    // return agent;
};

// Start processing events from the stream //从流开始处理事件
Agent.prototype._open = function () {
    if (this.closed) return;
    this.backend.agentsCount++;
    if (!this.stream.isServer) this.backend.remoteAgentsCount++;

    var agent = this;
    // 获取webscoket数据 接受  客户端 socket中的send
    // /处理来自客户端的传入消息
    this.stream.on('data', function (chunk) {
        // console.log('服务端获取到客户端socket发送的数据', chunk);
        // console.log('chunk======', chunk);
        if (agent.closed) return;

        var request = { data: chunk };
        // 中间件
        // agent.backend.trigger(
        //     agent.backend.MIDDLEWARE_ACTIONS.receive,
        //     agent,
        //     request,
        //     // 直接执行到这
        //     function (err) {
        // 回调函数
        var callback = function (err, message) {
            //发送消息给自己客户端
            // console.log('发送消息给自己客户端=', request.data);
            agent._reply(request.data, err, message);
        };

        // 有消息
        agent._handleMessage(request.data, callback);
        //         }
        //     );
    });

    // var cleanup = agent._cleanup.bind(agent);
    // this.stream.on('end', cleanup);
    // this.stream.on('close', cleanup);
};

// Handle an incoming message from the client //处理来自客户端的传入消息
Agent.prototype._handleMessage = function (request, callback) {
    try {
        switch (request.a) {
            // 服务端接收到hs
            case 'hs':
                if (request.id) {
                    this.src = request.id;
                }
                // console.log('request======', request);
                // debugger;
                // 发送一个hs给客户端
                return callback(null, this._initMessage('hs'));
            case 'qf':
                return this._queryFetch(
                    request.id,
                    request.c,
                    request.q,
                    getQueryOptions(request),
                    callback
                );
            case 'qs':
                return this._querySubscribe(
                    request.id,
                    request.c,
                    request.q,
                    getQueryOptions(request),
                    callback
                );
            case 'qu':
                return this._queryUnsubscribe(request.id, callback);
            case 'bf':
                return this._fetchBulk(request.c, request.b, callback);
            case 'bs':
                return this._subscribeBulk(request.c, request.b, callback);
            case 'bu':
                return this._unsubscribeBulk(request.c, request.b, callback);
            case 'f':
                return this._fetch(request.c, request.d, request.v, callback);
            case 's':
                //客户端初始化
                console.log('客户端初始化 request=', request);
                return this._subscribe(
                    request.c, // 文档集合key
                    request.d, // 文档id
                    request.v, // 文档版本
                    callback
                );
            case 'u':
                return this._unsubscribe(request.c, request.d, callback);
            case 'op': // op 操作类
                // Normalize the properties submitted 获取到编辑的op
                var op = createClientOp(request, this._src());
                if (op.seq >= util.MAX_SAFE_INTEGER) {
                    return callback(
                        new ShareDBError(
                            ERROR_CODE.ERR_CONNECTION_SEQ_INTEGER_OVERFLOW,
                            'Connection seq has exceeded the max safe integer, maybe from being open for too long'
                        )
                    );
                }
                if (!op) {
                    return callback(
                        new ShareDBError(
                            ERROR_CODE.ERR_MESSAGE_BADLY_FORMED,
                            'Invalid op message'
                        )
                    );
                }
                // 提交
                // console.log('this._submit========');
                // console.log('request=======', request);
                // console.log('op=======', op);
                // console.log('callback=======', callback);
                //　发送给其他客户端
                return this._submit(
                    request.c,
                    request.d,
                    op,
                    callback // 发送给当前socket
                );

            case 'nf':
                return this._fetchSnapshot(
                    request.c,
                    request.d,
                    request.v,
                    callback
                );
            case 'nt':
                return this._fetchSnapshotByTimestamp(
                    request.c,
                    request.d,
                    request.ts,
                    callback
                );
            case 'p':
                if (!this.backend.presenceEnabled) return;
                var presence = this._createPresence(request);
                if (
                    presence.t &&
                    !util.supportsPresence(types.map[presence.t])
                ) {
                    return callback({
                        code: ERROR_CODE.ERR_TYPE_DOES_NOT_SUPPORT_PRESENCE,
                        message:
                            'Type does not support presence: ' + presence.t,
                    });
                }
                return this._broadcastPresence(presence, callback);
            case 'ps':
                if (!this.backend.presenceEnabled) return;
                return this._subscribePresence(
                    request.ch,
                    request.seq,
                    callback
                );
            case 'pu':
                return this._unsubscribePresence(
                    request.ch,
                    request.seq,
                    callback
                );
            default:
                callback(
                    new ShareDBError(
                        ERROR_CODE.ERR_MESSAGE_BADLY_FORMED,
                        'Invalid or unknown message'
                    )
                );
        }
    } catch (err) {
        callback(err);
    }
};

// 发送消息给自己客户端去除op操作
Agent.prototype._reply = function (request, err, message) {
    //    console.log('_reply=', request);
    var agent = this;
    var backend = agent.backend;
    // if (err) {
    //     console.log('err====================',err)
    //     //获取应答错误对象
    //     request.error = getReplyErrorObject(err);
    //     //
    //     agent.send(request);
    //     return;
    // }

    if (!message) message = {};

    message.a = request.a;
    if (request.id) {
        message.id = request.id;
    } else {
        if (request.c) {
            message.c = request.c;
        }
        if (request.d) {
            message.d = request.d;
        }
        if (request.b && !message.data) {
            message.b = request.b;
        }
    }
    // 去除 op 操作
    var middlewareContext = { request: request, reply: message };
    // console.log('middlewareContext.reply=', middlewareContext.reply);
    agent.send(middlewareContext.reply);
};

// 发送信息给客户端
Agent.prototype.send = function (message) {
    // console.log('Agent.prototype.send  message = ', message);
    // Quietly drop replies if the stream was closed
    if (this.closed) return;
    // 发消息给客户
    this.stream.write(message);
};

module.exports = Backend;
emitter.mixin(Backend);
