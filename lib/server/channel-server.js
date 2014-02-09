var events  = require('events'),
    restify = require('restify'),
    sio     = require('socket.io'),
    util    = require('util'),
    async   = require('async'),
    
    serverUtils       = require('./utils'),
    database          = require('../mongodb-persister/database'), 
    NodeManager       = require('../node-manager/node-manager.js').NodeManager,
    SessionManager    = require('../session-manager/session-manager.js').SessionManager,
    SessionSubscriber = require('../session-manager/session-subscriber.js').SessionSubscriber,
    mongoPersister    = require('../mongodb-persister/mongoPersister');

var Gcm = require('../mobile/gcm').Gcm;
var ChannelServer = exports.ChannelServer = function (options) {
  if ( options.gcm_api_key != '' ){
    Gcm = new Gcm( options.gcm_api_key );
  }
  if (!options || !options.port) {
    throw new Error('Both `options` and `options.port` are required.');
  }
  
  var self  = this;
  
  if (!options.host){ 
    options.host = options.host?options.host: serverUtils.getIP();
  }
  
  var _killProcess = function(){
    self.nodeManager.removeServerNode(options.host, options.port, process.exit);
  };
  
  process.on('SIGINT',_killProcess).on('SIGTERM',_killProcess); // ctrl+c , kill process(except -9)
  
  events.EventEmitter.call(this);
  
  this.options = options;
  
  // inner storage for socket ids.
  this.socketIds = {};

  // inner storage for channels
  this.channels = {};
  
  try {
    
    console.log('\n');
    async.parallel(
      [
        
        // 1. mongodb connection
        function(callback){
          
          database.config(
            self.options && self.options.mongodb && self.options.mongodb.address ? self.options.mongodb.address : '',
            'xpush',
            function (err, message) {
              if(!err) console.info('  - Mongodb is connected');
              callback(err);
            }
          );
          
        },
        
        // 2.node-manager
        function(callback){
          
          self.nodeManager = new NodeManager(
            self.options && self.options.zookeeper && self.options.zookeeper.address ? self.options.zookeeper.address : '',
            true, //false,   // In case of Channel Server, do not watch the status of server nodes.
            function (err) {
              if(!err){
                console.info('  - Zookeeper is connected');
                self.nodeManager.addServerNode(self.options.host, self.options.port, function (err, path) {
                  if(!err)console.info('  - Server Node is created : ' + path);
                  
                  var serverName = path.substring(path.lastIndexOf('/')+1, path.length);
                  self.serverName = serverName.split('^')[0];
                  
                  callback(err);
                });
              }else{
                callback(err);
              }
            }
          );
          
        },
        
        // 3. session-manager
        function(callback){
          
          self.sessionManager = new SessionManager(
            self.options && self.options.redis && self.options.redis.address ? self.options.redis.address : '',
            function (err) {
              if(!err) console.info('  - Redis is connected');
              callback(err);
            }
          );
        },
        
        // 4.Fork the message process
        function(callback){
          
          var mp_args =[ 
            self.options && self.options.mongodb && self.options.mongodb.address ? self.options.mongodb.address : '',
            'xpush',
            self.options && self.options.redis && self.options.redis.address ? self.options.redis.address : ''
          ];
          
          self.message_process = require('child_process').fork(__dirname+'/message-process.js', mp_args);
          self.message_process.on('message', function(data) {
            
            if(data.err){ 
              callback(data.err);
            }else{
              
              if( data.message && data.message == 'connect' ) {
                console.info('  - Message Process is forked'); 
                callback(null); 
              }else{
                // do somthing  
                console.log(' >> received from message-process: ' + data.message); // Do something ??
                callback(null);
              }
            }
          });
          
        }],
      
      // And then, STARTUP !!
      function(err, results){
        
        if(!err) {
          
          self.sessionSubscriber = new SessionSubscriber(
            self.options && self.options.redis && self.options.redis.address ? self.options.redis.address : '', self.serverName,
            function (err) {
              if(!err) console.info('  - Redis Substriber is connected');
              if(!err) self.startup();
              
            }
          );
        }
        
        
      }
    );
    
  } catch(err) {
    console.log(err);
  }
  
};

util.inherits(ChannelServer, events.EventEmitter);

ChannelServer.prototype.startup = function () {
  
  var self = this;
  
  this.server = restify.createServer();
  this.server.use(restify.bodyParser());
  this.server.use(restify.CORS( {origins: ['*']}));
  this.server.use(restify.fullResponse());
  // Needed this for OPTIONS preflight request: https://github.com/mcavage/node-restify/issues/284
  function unknownMethodHandler(req, res) {
    if (req.method.toUpperCase() === 'OPTIONS') {
      console.log('Received an options method request from: ' + req.headers.origin);
      var allowHeaders = ['Accept', 'Accept-Version', 'Content-Type', 'Api-Version', 'Origin', 'X-Requested-With', 'Authorization'];
      
      if (res.methods.indexOf('OPTIONS') === -1) {
        res.methods.push('OPTIONS');
      }
      
      res.header('Access-Control-Allow-Credentials', false);
      res.header('Access-Control-Expose-Headers', true);
      res.header('Access-Control-Allow-Headers', allowHeaders.join(', '));
      res.header('Access-Control-Allow-Methods', res.methods.join(', '));
      res.header('Access-Control-Allow-Origin', req.headers.origin);
      res.header('Access-Control-Max-Age', 1209600);
      
      return res.send(204);
    }
    else {
      return res.send(new restify.MethodNotAllowedError());
    }
  }
  this.server.on('MethodNotAllowed', unknownMethodHandler);  

  this.io = sio.listen(this.server);
  
  this.io.of('/session').authorization(function (handshakeData, callback) {
    
    var _app      = handshakeData.query.app;
    var _userId   = handshakeData.query.userId;
    var _deviceId = handshakeData.query.deviceId;
    var _token    = handshakeData.query.token;
    
    
    if( !_app || !_userId || !_token || !_deviceId ) {
      callback('Parameter is not corrected. (app, userId, deviceId, token) ', false);
      return;
    }
    
    mongoPersister.retrieveUser( _app, _userId, _deviceId, function (err, user) {
      
      if(err) {
        callback(err, false);
        return;
      }
      
      if(!user) {
        callback('User is not existed.', false);
        return;
      }else{
        if(user.token == _token){
          
          // ####################################### //
          handshakeData._app        = _app;
          handshakeData._userId     = _userId;
          handshakeData._deviceId   = _deviceId;
          // ####################################### //
          console.log('== session == '.red,_app.red,_userId.red,_deviceId.red);
          callback(null, true);
          
        }else{
          
          callback('Auth token is not available.', false);
        }
        return;
      }
      
    });
    
  }).on('connection', function (socket) {
    self.socketIds[
      socket.handshake._app+'_'+
      socket.handshake._userId+'_'+
      socket.handshake._deviceId
    ] = socket.id;
    console.log('== session socket id =='.red, socket.id.red);
    socket.on('channel-create', function (params, callback) {
      
      if(!params.users || params.users.length == 0){
        callback({
          status: 'error',
          message: 'Channel have to include users.'
        });
        return;
      }
      
      mongoPersister.createChannel(
        socket.handshake._app, 
        params.channel,  // optional (can auto-generate !)
        params.users, 
        function (err, data){
          
          if(err){  
            console.log(err);
            if(callback) callback({
              status: 'error',
              message: err
            });
            
          }else{

            self.channels[data.app+'^'+data.channel] = data.users;

            if(callback) callback({
              status: 'ok',
              result: data
            });
            
          }
        });
    });
    
    socket.on('channel-list', function (callback) {
      console.log('channel-list');
      mongoPersister.listChannel(
        socket.handshake._app, 
        socket.handshake._userId, 
        function (err, channels){
          if(err){  
            console.log(err);
            if(callback) callback({ 
              status: 'error',
              message: err
            });
            
          }else{
            if(callback) callback({
              status: 'ok',
              result: channels
            });
          }
        });
      
    });
    
    socket.on('channel-join', function (params, callback) {
      
      var err = serverUtils.validSocketParams(params, ['channel','userId']);
      if(err){
        callback(err);
        return;
      }
      
      mongoPersister.addChannelUser(
        socket.handshake._app, 
        params.channel, 
        socket.handshake._userId, 
        function (err, users){
          if(err){  
            console.log(err);
            if(callback) callback({
              status: 'error',
              message: err
            });
            
          }else{
           
            for(var i=0; i<users.length; i++){
              self.channels[_app+'^'+_channel].push(users[i]);
            }

            if(callback) callback({
              status: 'ok',
              result: users
            });
          }
        });
      
    });
    
    socket.on('channel-exit', function (params, callback) {
      
      var err = serverUtils.validSocketParams(params, ['channel']);
      if(err){
        callback(err);
        return;
      }
      
      mongoPersister.exitChannel(
        socket.handshake._app, 
        params.channel, 
        socket.handshake._userId, 
        function (err, channels){
          if(err){  
            console.log(err);
            if(callback) callback({
              status: 'error',
              message: err
            });
            
          }else{

            // TODO pull channels users and delete channels if user is not existed.

            if(callback) callback({
              status: 'ok',
              result: channels
            });
          }
        });
      
    });
    
    socket.on('user-list', function (params, callback) {
      console.log('user-list');
      console.log(callback);
      mongoPersister.searchUser(
        socket.handshake._app, 
        params.keys,    // optional
        params.values,  // optional
        function (err, users){
          console.log(arguments);
          if(err){ 
            
            console.log(err);
            if(callback) callback({
              status: 'error',
              message: err
            });
            
          }else{
            if(callback) callback({
              status: 'ok',
              result: users
            });
          }
        });
      
    });
/*
    socket.on('message-unread', function (params, callback){

      var err = serverUtils.validSocketParams(params, ['channel']);
      if(err){
        callback(err);
        return;
      }

      mongoPersister.unReadMessages(
        socket.handshake._app, 
        params.channel,  // from parameters.
        socket.handshake._userId,
        socket.handshake._deviceId,

        function(err, data){
          if(err){
            console.log(err);
            if(callback) callback({
              status: 'error',
              message: err
            });
            return;
          }else{
            if(callback) callback({
              status: 'ok',
              result: data
            });
          }
        }

      );

    });
*/
    
    socket.on('disconnect', function () {
      
      delete self.socketIds[
        socket.handshake._app+'_'+
        socket.handshake._userId+'_'+
        socket.handshake._deviceId
      ];

    });
    
  });
  
  
  this.io.of('/channel').authorization(function (handshakeData, callback) {
    
    // TODO 
    // Check the channel is available (Existed? ) ?
    // or this is wasted ?
    var _app      = handshakeData.query.app;
    var _channel  = handshakeData.query.channel;
    var _server   = handshakeData.query.server;
    var _userId   = handshakeData.query.userId;
    var _deviceId = handshakeData.query.deviceId;
    
    if( !_app || !_channel || !_server ) {
      callback('Parameter is not corrected. (app, channel, server) ', false);
      return; 
    }
    
    // ####################################### //
    handshakeData._app   		= _app;
    handshakeData._channel  = _channel;
    handshakeData._server   = _server;
    handshakeData._userId   = _userId;
    handshakeData._deviceId = _deviceId;
    // ####################################### //
    console.log('== channel == '.red,_app.red,_channel.red,_server.red,_userId.red,_deviceId.red);

    if( !self.channels[_app+'^'+_channel] ){
      mongoPersister.getChannel(_app, _channel, function (err, channel, msg) {
        if(err) {
          callback(err, false);
        }else{

          if(channel) {
            self.channels[_app+'^'+_channel] = channel.users;
            callback(null, true);
          }else{
            callback(msg, false);
          }
          
        }
      });

    }else{
    
      callback(null, true);
    }
  }).on('connection', function (socket) { 
    var _room = socket.handshake._app+'^'+socket.handshake._channel;
    console.log('== socketId == '.red,socket.id.red);    
    console.log('== channel room == '.red,_room.red);

    socket.join(_room);
    
    socket._userId 		= socket.handshake._userId
    socket._deviceId 	= socket.handshake._deviceId
    
    var _count_of_this_channel = 
        self.io.of('/channel').clients(_room).length;
    
    self.sessionManager.update(
      socket.handshake._app, 
      socket.handshake._channel, 
      socket.handshake._server, 
      _count_of_this_channel);

    socket.on('send', function (params, callback) {
      console.log('message send'.red, params); 
      var err = serverUtils.validSocketParams(params, ['name', 'data']);
      if(err){ 
        console.log(err);
        if(callback) callback({
          status: 'error',
          message: err
        });
        return;
      }
      
      self.send(
        socket.handshake._app, 
        socket.handshake._channel, 
        params.name, 
        params.data, 
        callback);
      
    });

    socket.on('message-unread', function (callback){
      console.log('messsage-unread');
      mongoPersister.unReadMessages(
        socket.handshake._app, 
        socket.handshake._channel, 
        socket.handshake._userId,
        socket.handshake._deviceId,

        function(err, data){
          if(err){
            console.log(err);
            if(callback) callback({
              status: 'error',
              message: err
            });
            return;
          }else{
            if(callback) callback({
              status: 'ok',
              result: data
            });
          }
        }

      );

    });

    socket.on('message-received', function (callback){
      console.log('message-received');
      return;
      mongoPersister.removeMessage(
        socket.handshake._app, 
        socket.handshake._channel, 
        socket.handshake._userId,
        socket.handshake._deviceId,

        function(err, data){
          if(err){
            console.log(err);
            if(callback) callback({
              status: 'error',
              message: err
            });
            return;
          }else{
            if(callback) callback({
              status: 'ok'
            });
          }
        }

      );

    });
    
    socket.on('disconnect', function () {
      
      var _a = socket.handshake._app;      
      var _c = socket.handshake._channel;
      
      var _room = _a+'^'+_c;
      
      socket.leave(_room);
      
      var _count_of_this_channel = 0;
      if(self.io.of('/channel').clients(_room)){
        _count_of_this_channel = self.io.of('/channel').clients(_room).length;
      }
      
      self.sessionManager.update(
        _a, _c, socket.handshake._server, _count_of_this_channel
      );
      
    });
    
  });
  
  // notification !!!!
  self.sessionSubscriber.on('_received_message', function(receivedData) {

    console.log('sessionSubscriber - message ' , receivedData);

    var _socketId = self.socketIds[
      receivedData.app+'_'+
      receivedData.userId+'_'+
      receivedData.deviceId
    ];

    console.log('== socketId ==' ,_socketId);
    var _socket = self.io.of('/session').socket(_socketId);
    //var _room = receivedData.app+'^'+receivedData.channel;

    //var _socket = self.io.of('/session').socket(_socketId);
    console.log('_socket', _socket);
    if(_socket && _socket.id != undefined ) { // applicacation is alive. Session socket is connected !!

      _socket.emit('NOTIFICATION', {
        name: receivedData.name,
        data: receivedData.data,
        channel : receivedData.channel
      });
      
    } else { // application was OFF.
      
      if(receivedData.notiId){
        
        // existed mobile notification token ?
        // TODO implements GCM / APN process !!!!!
        if( Gcm.sender != undefined ){
          var gcmIds = [];
          gcmIds.push( receivedData.notiId );
          var data = null;
          if( typeof receivedData.data == 'string' ){
            data = {'title':receivedData.data, 'message':receivedData.data};
          } else {
            data = receivedData.data;
          }
          Gcm.send( gcmIds, data );
        }
      }else{
        
        // This is not support for Mobile Notification. Do Nothing !!!
      }
    }
    
  });

  // message from session server 
  self.sessionSubscriber.on('_send_message', function(receivedData) {
    self.send(receivedData.app, receivedData.channel, receivedData.name, receivedData.data);
  });

  
  if(this.options.type && this.options.type == 'PROXY'){
    require('../routes/routes')(self.server, self.nodeManager);
  }
  
  this.server.listen(this.options.port, function () {
    self.emit('connected', self.server.url, self.options.port);
  });
  
};


ChannelServer.prototype.send = function (_app, _channel, _name, _data, callback) {
  console.log('ChannelServer send : ',_app,_channel,_name,_data);
  var self = this;
  var _room = _app + '^' + _channel;
  console.log('room',_room);
  if(this.io.of('/channel').in(_room) != undefined){
    console.log('global emit :'.red,_name.blue);
    _data.channel = _channel;
    this.io.of('/channel').in(_room).emit(_name, _data);
    console.log(self.io.of('/channel').clients(_room));
  }
  
  // TODO
  // Using the mongodb aggregation or somthing efficient !!!!
  // And by forked process !!!
  
  var _tmpSockets = self.io.of('/channel').clients(_room);
  var _tmpIds     = {}; 
  
  for(var i=0; i<_tmpSockets.length; i++){
    _tmpIds[_tmpSockets[i]._userId+"^"+_tmpSockets[i]._deviceId] = _tmpSockets[i].id;
  }
  
  var users = this.channels[_app+'^'+_channel];
  console.log('uesrs',users);
  var _users = [];
  for(var x=0; x<users.length; x++){

    if(!_tmpIds[users[x].userId+"^"+users[x].deviceId]){

      _users.push({
        userId:   users[x].userId,
        deviceId: users[x].deviceId
      });

      var serverNode = self.nodeManager.getServerNode(_app + users[x].userId);
        
      self.sessionManager.publish(
        serverNode.name, 
        {
          _type: 'message', /* IMPORTANT */
          app: _app,
          channel: _channel,
          userId: users[x].userId,
          deviceId: users[x].deviceId,
          notiId: users[x].notiId,
          name: _name, 
          data: _data
        } 
      );

    }
  }

  if( _users.length > 0) {

    mongoPersister.storeMessages(
      _app, 
      _channel, 
      _name,
      _data, 
      _users,
      function (err) {
        if(err) {
          console.log(err);
          if(callback) callback(err);
        }else{
          if(callback) callback(null);
        }
      }
    );
  }else{
    if(callback) callback(null);
  }
 
  
  /*
  this.message_process.send({
    action: 'notification',
    app: _app,
    channel: _channel,
    data: _data 
  });
  */
  
};

