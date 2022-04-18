var util = require('./util');

var types = require('./types');
function guid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(
        /[xy]/g,
        function (c) {
            var r = (Math.random() * 16) | 0,
                v = c == 'x' ? r : (r & 0x3) | 0x8;
            return v.toString(16);
        }
    );
}

/**
 * Agent deserializes the wire protocol messages received from the stream and
 * calls the corresponding functions on its Agent. It uses the return values
 * to send responses back. Agent also handles piping the operation streams
 * provided by a Agent.
*代理反序列化从流和接收的有线协议消息  
调用Agent上相应的函数。 它使用返回值  
返回响应。 代理还处理操作流的管道  
*由代理提供。  
 
 *
 * @param {Backend} backend
 * @param {Duplex} stream connection to a client
 */
function Agent(
    backend, // backend 实例
    stream // webscoket 操作流
) {
    this.backend = backend;
    this.stream = stream;

    this.clientId = guid();
    // src is a client-configurable "id" which the client will set in its handshake,
    // and attach to its ops. This should take precedence over clientId if set.
    // Only legacy clients, or new clients connecting for the first time will use the
    // Agent-provided clientId. Ideally we'll deprecate clientId in favour of src
    // in the next breaking change.
    // SRC是一个客户端可配置的id，客户端将在握手时设置，
    //和附加到它的操作。 如果设置了，这应该优先于clientId。
    //只有旧的客户端，或新客户端第一次连接将使用
    // Agent-provided clientId。 理想情况下，我们会弃用clientId而用src
    //在下一个打破改变。
    this.src = null;
    this.connectTime = Date.now();

    // We need to track which documents are subscribed by the client. This is a
    // map of collection -> id -> stream
    //我们需要跟踪哪些文件被客户端订阅。 这是一个
    // map的集合-> id ->流
    this.subscribedDocs = {};

    // Map from queryId -> emitter
    //映射从查询id ->发射器
    this.subscribedQueries = {};

    // Track which documents are subscribed to presence by the client. This is a
    // map of channel -> stream
    //跟踪哪些文档被客户端订阅。 这是一个
    // >通道的映射
    this.subscribedPresences = {};
    // Highest seq received for a subscription request. Any seq lower than this
    // value is stale, and should be ignored. Used for keeping the subscription
    // state in sync with the client's desired state. Map of channel -> seq
    //订阅请求收到的最高seq。 低于这个的任何seq
    // value是陈旧的，应该被忽略。 用于保存订阅
    //状态与客户端期望的状态同步。 channel -> seq的映射
    this.presenceSubscriptionSeq = {};
    // Keep track of the last request that has been sent by each local presence
    // belonging to this agent. This is used to generate a new disconnection
    // request if the client disconnects ungracefully. This is a
    // map of channel -> id -> request
    //记录每个本地存在发送的最后一个请求
    //属于这个代理。 这用于生成新的断开连接
    //请求客户端断开连接。 这是一个
    // channel -> id ->请求
    this.presenceRequests = {};

    // We need to track this manually to make sure we don't reply to messages
    // after the stream was closed.
    //我们需要手动跟踪这个，以确保我们不回复消息
    //流关闭后。
    this.closed = false;

    // For custom use in middleware. The agent is a convenient place to cache
    // session state in memory. It is in memory only as long as the session is
    // active, and it is passed to each middleware call
    //在中间件中自定义使用。 代理是一个方便缓存的地方
    //会话状态 它只在会话存在时才在内存中
    //活动的，它被传递到每个中间件调用
    this.custom = {};

    // Send the legacy message to initialize old clients with the random agent Id
    //发送旧消息初始化旧客户端随机代理Id
    // 服务器自己先发送一次init给客户
    this.send(this._initMessage('init'));
}

//发送一个初始化 给客户端
Agent.prototype._initMessage = function (action) {
    return {
        a: action,
        protocol: 1,
        protocolMinor: 1,
        id: this._src(),
        type: types.defaultType.uri,
    };
};

// 发送信息给客户端
Agent.prototype.send = function (message) {
    // console.log('Agent.prototype.send  message = ', message);
    // Quietly drop replies if the stream was closed
    if (this.closed) return;
    // 发消息给客户
    this.stream.write(message);
};

Agent.prototype._src = function () {
    return this.src || this.clientId;
};

module.exports = Agent;
