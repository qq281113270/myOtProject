# mySharedb初始化流程

## 客户端 socket 已经连接上

### 地方

### 客户端:发送消息给服务端 { a: 'hs', id: null }

```
Connection.prototype.bindToSocket = function (socket) { 

     // ... 省略代码


    // socket 已经连接上
    socket.onopen = function () {
        console.log('客户端 socket 已经连接上');

        // 设置状态
        connection._setState('connecting');

        connection._initializeHandshake();
    };


     // ... 省略代码
}

// 发送{ a: "hs", id: this.id }给服务器  连上 socket 的时候先发送一个hs给服务器
Connection.prototype._initializeHandshake = function () {
    // 发送 消息
    console.info('发送消息给服务端', { a: 'hs', id: this.id });
    this.send({ a: 'hs', id: this.id });
};

```





