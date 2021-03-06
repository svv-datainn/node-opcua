"use strict";
/*global: require Buffer*/
/**
 * @module opcua.server
 */

require("requirish")._(module);
var s = require("lib/datamodel/structures");
var ApplicationType = s.ApplicationType;

var StatusCodes = require("lib/datamodel/opcua_status_code").StatusCodes;
var NumericRange = require("lib/datamodel/numeric_range").NumericRange;
var assert = require("better-assert");

var async = require("async");
var util = require("util");
var path = require("path");
var fs = require("fs");
var _ = require("underscore");
var url = require("url");

var debugLog = require("lib/misc/utils").make_debugLog(__filename);

var ServerEngine = require("lib/server/server_engine").ServerEngine;
var LocalizedText = require("lib/datamodel/localized_text").LocalizedText;

var browse_service = require("lib/services/browse_service");
var read_service = require("lib/services/read_service");
var write_service = require("lib/services/write_service");
var subscription_service = require("lib/services/subscription_service");
var register_server_service = require("lib/services/register_server_service");
var translate_service = require("lib/services/translate_browse_paths_to_node_ids_service");
var session_service = require("lib/services/session_service");
var call_service = require("lib/services/call_service");
var endpoints_service = require("lib/services/get_endpoints_service");
var ServerState = require("schemas/ServerState_enum").ServerState;
var EndpointDescription = endpoints_service.EndpointDescription;

var TimestampsToReturn = read_service.TimestampsToReturn;

var ActivateSessionRequest = session_service.ActivateSessionRequest;
var ActivateSessionResponse = session_service.ActivateSessionResponse;

var CreateSessionRequest = session_service.CreateSessionRequest;
var CreateSessionResponse = session_service.CreateSessionResponse;


var CloseSessionRequest = session_service.CloseSessionRequest;
var CloseSessionResponse = session_service.CloseSessionResponse;

var DeleteMonitoredItemsRequest = subscription_service.DeleteMonitoredItemsRequest;
var DeleteMonitoredItemsResponse = subscription_service.DeleteMonitoredItemsResponse;

var RepublishRequest = subscription_service.RepublishRequest;
var RepublishResponse = subscription_service.RepublishResponse;

var PublishRequest = subscription_service.PublishRequest;
var PublishResponse = subscription_service.PublishResponse;

var CreateSubscriptionRequest = subscription_service.CreateSubscriptionRequest;
var CreateSubscriptionResponse = subscription_service.CreateSubscriptionResponse;

var DeleteSubscriptionsRequest = subscription_service.DeleteSubscriptionsRequest;
var DeleteSubscriptionsResponse = subscription_service.DeleteSubscriptionsResponse;

var CreateMonitoredItemsRequest = subscription_service.CreateMonitoredItemsRequest;
var CreateMonitoredItemsResponse = subscription_service.CreateMonitoredItemsResponse;

var ModifyMonitoredItemsRequest = subscription_service.ModifyMonitoredItemsRequest;
var ModifyMonitoredItemsResponse = subscription_service.ModifyMonitoredItemsResponse;
var MonitoredItemModifyResult = subscription_service.MonitoredItemModifyResult;

var MonitoredItemCreateResult = subscription_service.MonitoredItemCreateResult;
var SetPublishingModeRequest = subscription_service.SetPublishingModeRequest;
var SetPublishingModeResponse = subscription_service.SetPublishingModeResponse;

var CallRequest = call_service.CallRequest;
var CallResponse = call_service.CallResponse;

var ReadRequest = read_service.ReadRequest;
var ReadResponse = read_service.ReadResponse;

var WriteRequest = write_service.WriteRequest;
var WriteResponse = write_service.WriteResponse;

var ReadValueId = read_service.ReadValueId;

var BrowseRequest = browse_service.BrowseRequest;
var BrowseResponse = browse_service.BrowseResponse;

var BrowseNextRequest = browse_service.BrowseNextRequest;
var BrowseNextResponse = browse_service.BrowseNextResponse;

var RegisterNodesRequest = browse_service.RegisterNodesRequest;
var RegisterNodesResponse = browse_service.RegisterNodesResponse;
var UnregisterNodesRequest = browse_service.UnregisterNodesRequest;
var UnregisterNodesResponse = browse_service.UnregisterNodesResponse;

var TranslateBrowsePathsToNodeIdsRequest = translate_service.TranslateBrowsePathsToNodeIdsRequest;
var TranslateBrowsePathsToNodeIdsResponse = translate_service.TranslateBrowsePathsToNodeIdsResponse;

var RegisterServerRequest = register_server_service.RegisterServerRequest;
var RegisterServerResponse = register_server_service.RegisterServerResponse;


var NodeId = require("lib/datamodel/nodeid").NodeId;
var DataValue = require("lib/datamodel/datavalue").DataValue;
var DataType = require("lib/datamodel/variant").DataType;
var AttributeIds = require("lib/datamodel/attributeIds").AttributeIds;

var MonitoredItem = require("lib/server/monitored_item").MonitoredItem;

var View = require("lib/address_space/view").View;

var crypto = require("crypto");

var dump = require("lib/misc/utils").dump;
var constructFilename = require("lib/misc/utils").constructFilename;

var OPCUAServerEndPoint = require("lib/server/server_end_point").OPCUAServerEndPoint;

var OPCUABaseServer = require("lib/server/base_server").OPCUABaseServer;


var Factory = function Factory(engine) {
    assert(_.isObject(engine));
    this.engine = engine;
};

var factories = require("lib/misc/factories");

Factory.prototype.constructObject = function (id) {
    return factories.constructObject(id);
};

var default_maxAllowedSessionNumber = 10;


function g_sendError(channel, message, ResponseClass, statusCode) {
    var response = new ResponseClass({
        responseHeader: {serviceResult: statusCode}
    });
    return channel.send_response("MSG", response, message);
}


var package_json_file = constructFilename("package.json");
var package_info = JSON.parse(fs.readFileSync(package_json_file));

var default_build_info = {
    productName: "NODEOPCUA-SERVER",
    productUri: null, // << should be same as default_server_info.productUri?
    manufacturerName: "Node-OPCUA : MIT Licence ( see http://node-opcua.github.io/)",
    softwareVersion: package_info.version,
    buildDate: fs.statSync(package_json_file).mtime
};


/**
 * @class OPCUAServer
 * @extends  OPCUABaseServer
 * @uses ServerEngine
 * @param options
 * @param [options.defaultSecureTokenLifetime = 60000] {Number} the default secure token life time in ms.
 * @param [options.timeout=10000] {Number}              the HEL/ACK transaction timeout in ms. Use a large value
 *                                                      ( i.e 15000 ms) for slow connections or embedded devices.
 * @param [options.port= 26543] {Number}                the TCP port to listen to.
 * @param [options.maxAllowedSessionNumber = 10 ]       the maximum number of concurrent sessions allowed.
 *
 * @param [options.nodeset_filename]{Array<String>|String} the nodeset.xml files to load
 * @param [options.serverInfo = null]                   the information used in the end point description
 * @param [options.serverInfo.applicationUri = "urn:NodeOPCUA-SimpleDemoServer"] {String}
 * @param [options.serverInfo.productUri = "SimpleDemoServer"]{String}
 * @param [options.serverInfo.applicationName = {text: "applicationName"}]{LocalizedText}
 * @param [options.serverInfo.gatewayServerUri = null]{String}
 * @param [options.serverInfo.discoveryProfileUri= null]{String}
 * @param [options.serverInfo.discoveryUrls = []]{Array<String>}
 * @param [options.securityPolicies= [SecurityPolicy.None,SecurityPolicy.Basic128Rsa15,SecurityPolicy.Basic256]]
 * @param [options.securityModes= [MessageSecurityMode.NONE,MessageSecurityMode.SIGN,MessageSecurityMode.SIGNANDENCRYPT]]
 * @param [options.allowAnonymous = true] tells if the server default endpoints should allow anonymous connection.
 * @param [options.userManager = null ] a object that implement a method isValidUser(userName,password) to check if the
 * @param [options.resourcePath=null] {String} resource Path is a string added at the end of the url such as "/UA/Server"
 * @param [options.alternateHostname=null] {String} alternate hostname to use
 *  UserNameIdentityToken is valid.
 * @constructor
 */
function OPCUAServer(options) {

    options = options || {};

    OPCUABaseServer.apply(this, arguments);

    var self = this;

    self.options = options;


    // build Info
    var buildInfo = _.clone(default_build_info);
    buildInfo = _.extend(buildInfo, options.buildInfo);

    // repair product name
    buildInfo.productUri = buildInfo.productUri || self.serverInfo.productUri;
    self.serverInfo.productUri = self.serverInfo.productUri || buildInfo.productUri;
    self.serverInfo.productName = self.serverInfo.productName || buildInfo.productName;

    self.engine = new ServerEngine({
        buildInfo: buildInfo,
        serverCapabilities: options.serverCapabilities,
        applicationUri: self.serverInfo.applicationUri
    });

    self.nonce = self.makeServerNonce();

    self.protocolVersion = 0;

    var port = options.port || 26543;
    assert(_.isFinite(port));

    self.objectFactory = new Factory(self.engine);

    // todo  should self.serverInfo.productUri  match self.engine.buildInfo.productUri ?

    options.allowAnonymous = ( options.allowAnonymous === undefined) ? true : options.allowAnonymous;

    // add the tcp/ip endpoint with no security
    var endPoint = new OPCUAServerEndPoint({
        port: port,
        defaultSecureTokenLifetime: options.defaultSecureTokenLifetime || 600000,
        timeout: options.timeout || 10000,
        certificate: self.getCertificate(),
        privateKey: self.getPrivateKey(),
        objectFactory: self.objectFactory,
        serverInfo: self.serverInfo
    });

    endPoint.addStandardEndpointDescriptions({
        securityPolicies: options.securityPolicies,
        securityModes: options.securityModes,
        allowAnonymous: options.allowAnonymous,
        resourcePath: options.resourcePath || "",
        hostname: options.alternateHostname
    });


    self.endpoints.push(endPoint);

    endPoint.on("message", function (message, channel) {
        self.on_request(message, channel);
    });

    endPoint.on("error", function (err) {
        console.log("OPCUAServer endpoint error", err);

        // set serverState to ServerState.Failed;
        self.engine.setServerState(ServerState.Failed);

        self.shutdown(function () {
        });
    });

    self.serverInfo.applicationType = ApplicationType.SERVER;

    self.maxAllowedSessionNumber = options.maxAllowedSessionNumber || default_maxAllowedSessionNumber;

    self.userManager = options.userManager || {
            isValidUser: function (/*userName,password*/) {
                return false;
            }
        };
    assert(_.isFunction(self.userManager.isValidUser));

}
util.inherits(OPCUAServer, OPCUABaseServer);

var ObjectRegisty = require("lib/misc/objectRegistry").ObjectRegisty;
var g_running_Servers = new ObjectRegisty();
OPCUAServer.getRunningServerCount = g_running_Servers.count.bind(g_running_Servers);


/**
 * total number of bytes written  by the server since startup
 * @property bytesWritten
 * @type {Number}
 */
OPCUAServer.prototype.__defineGetter__("bytesWritten", function () {

    return this.endpoints.reduce(function (accumulated, endpoint) {
        return accumulated + endpoint.bytesWritten;
    }, 0);
});

/**
 * total number of bytes read  by the server since startup
 * @property bytesRead
 * @type {Number}
 */
OPCUAServer.prototype.__defineGetter__("bytesRead", function () {
    return this.endpoints.reduce(function (accumulated, endpoint) {
        return accumulated + endpoint.bytesRead;
    }, 0);
});

/**
 * Number of transactions processed by the server since startup
 * @property transactionsCount
 * @type {Number}
 */
OPCUAServer.prototype.__defineGetter__("transactionsCount", function () {
    return this.endpoints.reduce(function (accumulated, endpoint) {
        return accumulated + endpoint.transactionsCount;
    }, 0);
});


/**
 * The server build info
 * @property buildInfo
 * @type {BuildInfo}
 */
OPCUAServer.prototype.__defineGetter__("buildInfo", function () {
    return this.engine.buildInfo;
});

/**
 * the number of connected channel on all existing end points
 * @property currentChannelCount
 * @type  {Number}
 *
 * TODO : move to base
 */
OPCUAServer.prototype.__defineGetter__("currentChannelCount", function () {

    var self = this;
    return self.endpoints.reduce(function (currentValue, endPoint) {
        return currentValue + endPoint.currentChannelCount;
    }, 0);
});


/**
 * The number of active subscriptions from all sessions
 * @property currentSubscriptionCount
 * @type {Number}
 */
OPCUAServer.prototype.__defineGetter__("currentSubscriptionCount", function () {
    var self = this;
    return self.engine.currentSubscriptionCount;
});

OPCUAServer.prototype.__defineGetter__("rejectedSessionCount", function () {
    return this.engine.rejectedSessionCount;
});
OPCUAServer.prototype.__defineGetter__("rejectedRequestsCount", function () {
    return this.engine.rejectedRequestsCount;
});
OPCUAServer.prototype.__defineGetter__("sessionAbortCount", function () {
    return this.engine.sessionAbortCount;
});
OPCUAServer.prototype.__defineGetter__("publishingIntervalCount", function () {
    return this.engine.publishingIntervalCount;
});

/**
 * create and register a new session
 * @method createSession
 * @return {ServerSession}
 */
OPCUAServer.prototype.createSession = function (options) {
    var self = this;
    return self.engine.createSession(options);
};

/**
 * the number of sessions currently active
 * @property currentSessionCount
 * @type {Number}
 */
OPCUAServer.prototype.__defineGetter__("currentSessionCount", function () {
    return this.engine.currentSessionCount;
});

/**
 * retrieve a session by authentication token
 * @method getSession
 *
 * @param authenticationToken
 * @param activeOnly search only for session that are not closed
 */
OPCUAServer.prototype.getSession = function (authenticationToken, activeOnly) {
    var self = this;
    return self.engine.getSession(authenticationToken, activeOnly);
};

/**
 * true if the server has been initialized
 * @property initialized
 * @type {Boolean}
 *
 */
OPCUAServer.prototype.__defineGetter__("initialized", function () {
    var self = this;
    return self.engine.address_space !== null;
});


/**
 * Initialize the server by installing default node set.
 *
 * @method initialize
 * @async
 *
 * This is a asynchronous function that requires a callback function.
 * The callback function typically completes the creation of custom node
 * and instruct the server to listen to its endpoints.
 *
 * @param {Function} done
 */
OPCUAServer.prototype.initialize = function (done) {

    var self = this;
    assert(!self.initialized);// already initialized ?

    g_running_Servers.register(self);

    self.engine.initialize(self.options, function () {
        self.emit("post_initialize");
        done();
    });
};


/**
 * Initiate the server by starting all its endpoints
 * @method start
 * @async
 * @param done {Function}
 */
OPCUAServer.prototype.start = function (done) {

    var self = this;
    var tasks = [];
    if (!self.initialized) {
        tasks.push(function (callback) {
            self.initialize(callback);
        });
    }
    tasks.push(function (callback) {
        OPCUABaseServer.prototype.start.call(self, function (err) {
            if (err) {
                self.shutdown(function (/*err2*/) {
                    callback(err);
                });
            }
            else {
                callback();
            }
        });
    });

    async.series(tasks, done);

};

/**
 * shutdown all server endpoints
 * @method shutdown
 * @async
 * @param  [timeout=0] {Integer} the timeout before the server is actually shutted down
 * @param  done {Function}
 *
 *
 * @example
 *
 *    // shutdown immediatly
 *    server.shutdown(function(err) {
 *    });
 *
 *    // shutdown within 10 seconds
 *    server.shutdown(10000,function(err) {
 *    });
 */
OPCUAServer.prototype.shutdown = function (timeout, done) {

    if (_.isFunction(timeout) && !done) {
        done = timeout;
        timeout = 10;
    }
    var self = this;

    self.engine.setServerState(ServerState.Shutdown);

    setTimeout(function () {
        self.engine.shutdown();

        OPCUABaseServer.prototype.shutdown.call(self, function (err) {
            g_running_Servers.unregister(self);
            done(err);
        });

    }, timeout);

};

var computeSignature = require("lib/misc/security_policy").computeSignature;
var verifySignature = require("lib/misc/security_policy").verifySignature;

OPCUAServer.prototype.computeServerSignature = function (channel, clientCertificate, clientNonce) {
    var self = this;
    return computeSignature(clientCertificate, clientNonce, self.getPrivateKey(), channel.messageBuilder.securityPolicy);
};

OPCUAServer.prototype.verifyClientSignature = function (session, channel, clientSignature) {

    var self = this;

    var clientCertificate = channel.receiverCertificate;
    var securityPolicy = channel.messageBuilder.securityPolicy;
    var serverCertificate = self.getCertificate();
    var result = verifySignature(serverCertificate, session.nonce, clientSignature, clientCertificate, securityPolicy);

    return result;
};


var minSessionTimeout = 10; // 10 milliseconds
var defaultSessionTimeout = 1000; // 1 second
var maxSessionTimeout = 1000 * 60 * 5; // 5 minutes

function _adjust_session_timeout(sessionTimeout) {
    var revisedSessionTimeout = sessionTimeout || defaultSessionTimeout;
    revisedSessionTimeout = Math.min(revisedSessionTimeout, maxSessionTimeout);
    revisedSessionTimeout = Math.max(revisedSessionTimeout, minSessionTimeout);
    //xx console.log("xxxxx requested time out = ",request.requestedSessionTimeout," revised= ",revisedSessionTimeout);
    return revisedSessionTimeout;
}


// session services
OPCUAServer.prototype._on_CreateSessionRequest = function (message, channel) {

    var server = this;
    var request = message.request;
    assert(request instanceof CreateSessionRequest);

    function rejectConnection(statusCode) {

        server.engine._rejectedSessionCount += 1;

        var response = new CreateSessionResponse({responseHeader: {serviceResult: statusCode}});
        channel.send_response("MSG", response, message);
        // and close !
    }


    // check if session count hasn't reach the maximum allowed sessions
    if (server.currentSessionCount >= server.maxAllowedSessionNumber) {
        return rejectConnection(StatusCodes.BadTooManySessions);
    }

    // Duration Requested maximum number of milliseconds that a Session should remain open without activity.
    // If the Client fails to issue a Service request within this interval, then the Server shall automatically
    // terminate the Client Session.
    var revisedSessionTimeout = _adjust_session_timeout(request.requestedSessionTimeout);


    // Release 1.02 page 27 OPC Unified Architecture, Part 4: CreateSession.clientNonce
    // A random number that should never be used in any other request. This number shall have a minimum length of 32
    // bytes. Profiles may increase the required length. The Server shall use this value to prove possession of
    // its application instance Certificate in the response.
    if (!request.clientNonce || request.clientNonce.length < 32) {
        if (channel.securityMode !== endpoints_service.MessageSecurityMode.NONE) {
            console.log("SERVER with secure connection: Missing or invalid client Nonce ".red, request.clientNonce && request.clientNonce.toString("hex"));
            return rejectConnection(StatusCodes.BadNonceInvalid);
        }
    }

    function validate_applicationUri(applicationUri, clientCertificate) {

        // if session is insecure there is no need to check certificate information
        if (channel.securityMode === endpoints_service.MessageSecurityMode.NONE) {
            return true; // assume correct
        }
        if (!clientCertificate || clientCertificate.length === 0) {
            return true;// can't check
        }
        var exploreCertificate = require("lib/misc/crypto_explore_certificate").exploreCertificate;
        var e = exploreCertificate(clientCertificate);
        var applicationUriFromCert = e.tbsCertificate.extensions.subjectAltName.uniformResourceIdentifier[0];
        return applicationUriFromCert === applicationUri;
    }

    // check application spoofing
    // check if applicationUri in createSessionRequest matches applicationUri in client Certificate
    if (!validate_applicationUri(request.clientDescription.applicationUri, request.clientCertificate)) {
        return rejectConnection(StatusCodes.BadCertificateUriInvalid);
    }


    // see Release 1.02  27  OPC Unified Architecture, Part 4

    var session = server.createSession({sessionTimeout: revisedSessionTimeout});
    assert(session);

    session.clientDescription = request.clientDescription;
    session.sessionName = request.sessionName;

    // Depending upon on the  SecurityPolicy  and the  SecurityMode  of the  SecureChannel,  the exchange of
    // ApplicationInstanceCertificates   and  Nonces  may be optional and the signatures may be empty. See
    // Part  7  for the definition of  SecurityPolicies  and the handling of these parameters


    // serverNonce:
    // A random number that should never be used in any other request.
    // This number shall have a minimum length of 32 bytes.
    // The Client shall use this value to prove possession of its application instance
    // Certificate in the ActivateSession request.
    // This value may also be used to prove possession of the userIdentityToken it
    // specified in the ActivateSession request.
    //
    // ( this serverNonce will only be used up to the _on_ActivateSessionRequest
    //   where a new nonce will be created)
    session.nonce = server.makeServerNonce();
    session.secureChannelId = channel.secureChannelId;
    channel.session_nonce = session.nonce;

    assert(session.nonce && session.nonce instanceof Buffer);

    session.channel = channel;

    var response = new CreateSessionResponse({
        // A identifier which uniquely identifies the session.
        sessionId: session.nodeId,

        // A unique identifier assigned by the Server to the Session.
        // The token used to authenticate the client in subsequent requests.
        authenticationToken: session.authenticationToken,

        revisedSessionTimeout: revisedSessionTimeout,

        serverNonce: session.nonce,

        // serverCertificate: type ApplicationServerCertificate
        // The application instance Certificate issued to the Server.
        // A Server shall prove possession by using the private key to sign the Nonce provided
        // by the Client in the request. The Client shall verify that this Certificate is the same as
        // the one it used to create the SecureChannel.
        // The ApplicationInstanceCertificate type is defined in 7.2.
        // If the securityPolicyUri is NONE and none of the UserTokenPolicies requires
        // encryption, the Server shall not send an ApplicationInstanceCertificate and the Client
        // shall ignore the ApplicationInstanceCertificate.
        serverCertificate: server.getCertificate(),

        // The endpoints provided by the server.
        // The Server shall return a set of EndpointDescriptions available for the serverUri
        // specified in the request.[...]
        // The Client shall verify this list with the list from a Discovery Endpoint if it used a Discovery
        // Endpoint to fetch the EndpointDescriptions.
        // It is recommended that Servers only include the endpointUrl, securityMode,
        // securityPolicyUri, userIdentityTokens, transportProfileUri and securityLevel with all
        // other parameters set to null. Only the recommended parameters shall be verified by
        // the client.
        serverEndpoints: server._get_endpoints(),

        //This parameter is deprecated and the array shall be empty.
        serverSoftwareCertificates: null,

        // This is a signature generated with the private key associated with the
        // serverCertificate. This parameter is calculated by appending the clientNonce to the
        // clientCertificate and signing the resulting sequence of bytes.
        // The SignatureAlgorithm shall be the AsymmetricSignatureAlgorithm specified in the
        // SecurityPolicy for the Endpoint.
        // The SignatureData type is defined in 7.30.
        serverSignature: server.computeServerSignature(channel, request.clientCertificate, request.clientNonce),

        // The maximum message size accepted by the server
        // The Client Communication Stack should return a Bad_RequestTooLarge error to the
        // application if a request message exceeds this limit.
        // The value zero indicates that this parameter is not used.
        maxRequestMessageSize: 0x4000000

    });

    server.emit("create_session", session);

    session.on("session_closed", function (session, deleteSubscriptions) {
        server.emit("session_closed", session, deleteSubscriptions);
    });

    assert(response.authenticationToken);
    channel.send_response("MSG", response, message);
};

var UserNameIdentityToken = session_service.UserNameIdentityToken;
var AnonymousIdentityToken = session_service.AnonymousIdentityToken;
var securityPolicy_m = require("lib/misc/security_policy");
var SecurityPolicy = securityPolicy_m.SecurityPolicy;


function ajustSecurityPolicy(channel, userTokenPolicy_securityPolicyUri) {
    // check that userIdentityToken
    var securityPolicy = securityPolicy_m.fromURI(userTokenPolicy_securityPolicyUri);

    // if the security policy is not specified we use the session security policy
    if (securityPolicy === SecurityPolicy.Invalid) {
        securityPolicy = securityPolicy_m.fromURI(channel.clientSecurityHeader.securityPolicyUri);
        assert(securityPolicy);
    }
    return securityPolicy;
}
OPCUAServer.prototype.isValidUserNameIdentityToken = function (channel, session, userTokenPolicy, userIdentityToken) {

    var self = this;

    assert(userIdentityToken instanceof UserNameIdentityToken);

    var securityPolicy = ajustSecurityPolicy(channel, userTokenPolicy.securityPolicyUri);

    var cryptoFactory = securityPolicy_m.getCryptoFactory(securityPolicy);
    if (!cryptoFactory) {
        throw new Error(" Unsupported security Policy");
    }

    if (userIdentityToken.encryptionAlgorithm !== cryptoFactory.asymmetricEncryptionAlgorithm) {
        console.log("invalid encryptionAlgorithm");
        console.log("userTokenPolicy", userTokenPolicy.toString());
        console.log("userTokenPolicy", userIdentityToken.toString());
        return false;
    }
    var userName = userIdentityToken.userName;
    var password = userIdentityToken.password;
    if (!userName || !password) {
        return false;
    }
    return true;
};

OPCUAServer.prototype.userNameIdentityTokenAuthenticateUser = function (channel, session, userTokenPolicy, userIdentityToken) {
    var self = this;
    assert(userIdentityToken instanceof UserNameIdentityToken);
    assert(self.isValidUserNameIdentityToken(channel, session, userTokenPolicy, userIdentityToken));

    var securityPolicy = ajustSecurityPolicy(channel, userTokenPolicy.securityPolicyUri);

    var serverPrivateKey = self.getPrivateKey();

    var serverNonce = session.nonce;
    assert(serverNonce instanceof Buffer);

    var cryptoFactory = securityPolicy_m.getCryptoFactory(securityPolicy);
    if (!cryptoFactory) {
        throw new Error(" Unsupported security Policy");
    }
    var userName = userIdentityToken.userName;
    var password = userIdentityToken.password;

    var buff = cryptoFactory.asymmetricDecrypt(password, serverPrivateKey);
    var length = buff.readUInt32LE(0) - serverNonce.length;
    password = buff.slice(4, 4 + length).toString("utf-8");
    return self.userManager.isValidUser(userName, password);

};


function findUserTokenByPolicy(endpoint_description, policyId) {
    assert(endpoint_description instanceof EndpointDescription);
    var r = _.filter(endpoint_description.userIdentityTokens, function (userIdentity) {
        // assert(userIdentity instanceof UserTokenPolicy)
        assert(userIdentity.tokenType);
        return userIdentity.policyId === policyId;
    });
    return r.length === 0 ? null : r[0];
}

OPCUAServer.prototype.isValidUserIdentityToken = function (channel, session, userIdentityToken) {

    var self = this;
    assert(userIdentityToken);

    var endpoint_desc = channel.endpoint;
    assert(endpoint_desc instanceof EndpointDescription);

    var userTokenPolicy = findUserTokenByPolicy(endpoint_desc, userIdentityToken.policyId);
    if (!userTokenPolicy) {
        // cannot find token with this policyId
        return false;
    }
    //
    if (userIdentityToken instanceof UserNameIdentityToken) {
        return self.isValidUserNameIdentityToken(channel, session, userTokenPolicy, userIdentityToken);
    }
    return true;
};
OPCUAServer.prototype.isUserAuthorized = function (channel, session, userIdentityToken) {

    var self = this;
    assert(userIdentityToken);

    var endpoint_desc = channel.endpoint;
    assert(endpoint_desc instanceof EndpointDescription);

    var userTokenPolicy = findUserTokenByPolicy(endpoint_desc, userIdentityToken.policyId);
    assert(userTokenPolicy);
    // find if a userToken exists
    if (userIdentityToken instanceof UserNameIdentityToken) {
        return self.userNameIdentityTokenAuthenticateUser(channel, session, userTokenPolicy, userIdentityToken);
    }
    return true;

};

OPCUAServer.prototype.makeServerNonce = function () {
    return crypto.randomBytes(32);
};

function sameIdentityToken(token1, token2) {
    if (token1 instanceof UserNameIdentityToken) {
        if (!token2 instanceof UserNameIdentityToken) {
            return false;
        }
        if (token1.userName !== token2.userName) {
            return false;
        }
        if (token1.password.toString("hex") !== token2.password.toString("hex")) {
            return false;
        }
    } else if (token2 instanceof AnonymousIdentityToken) {
        if (!token2 instanceof AnonymousIdentityToken) {
            return false;
        }
        if (token1.policyId !== token2.policyId) {
            return false;
        }
        return true;
    }
    assert(0, " Not implemented yet");
    return false;
}
function thumbprint(certificate) {
    return certificate ? certificate.toString("base64") : "";
}

// TODO : implement this:
//
// When the ActivateSession Service is called for the first time then the Server shall reject the request
// if the SecureChannel is not same as the one associated with the CreateSession request.
// Subsequent calls to ActivateSession may be associated with different SecureChannels. If this is the
// case then the Server shall verify that the Certificate the Client used to create the new
// SecureChannel is the same as the Certificate used to create the original SecureChannel. In addition,
// the Server shall verify that the Client supplied a UserIdentityToken that is identical to the token
// currently associated with the Session. Once the Server accepts the new SecureChannel it shall
// reject requests sent via the old SecureChannel.
/**
 *
 * @method _on_ActivateSessionRequest
 * @param message {Buffer}
 * @param channel {ServerSecureChannelLayer}
 * @private
 *
 *
 */
OPCUAServer.prototype._on_ActivateSessionRequest = function (message, channel) {

    var server = this;
    var request = message.request;
    assert(request instanceof ActivateSessionRequest);

    // get session from authenticationToken
    var authenticationToken = request.requestHeader.authenticationToken;

    var session = server.getSession(authenticationToken);


    function rejectConnection(statusCode) {
        server.engine._rejectedSessionCount += 1;
        var response = new ActivateSessionResponse({responseHeader: {serviceResult: statusCode}});

        channel.send_response("MSG", response, message);
        // and close !
    }

    var response;

    /* istanbul ignore next */
    if (!session) {
        console.log(" Bad Session in  _on_ActivateSessionRequest".yellow.bold, authenticationToken.value.toString("hex"));
        return rejectConnection(StatusCodes.BadSessionNotActivated);
    }

    // OpcUA 1.02 part 3 $5.6.3.1 ActiveSession Set page 29
    // When the ActivateSession  Service  is called f or the first time then the Server shall reject the request
    // if the  SecureChannel  is not same as the one associated with the  CreateSession  request.
    if (session.status === "new") {
        if (channel.session_nonce !== session.nonce) {
            // it looks like session activation is being using a channel that is not the
            // one that have been used to create the session
            return rejectConnection(StatusCodes.BadSessionNotActivated);
        }
    }

    // OpcUA 1.02 part 3 $5.6.3.1 ActiveSession Set page 29
    // ... Subsequent calls to  ActivateSession  may be associated with different  SecureChannels.  If this is the
    // case then  the  Server  shall verify that the  Certificate  the  Client  used to create the new
    // SecureChannel  is the same as the  Certificate  used to create the original  SecureChannel.

    if (session.status === "active") {

        console.log(" Session is being transferred from channel",
            session.channel.secureChannelId.toString().cyan,
            " to channel ", channel.secureChannelId.toString().cyan);

        // session is being reassigned to a new Channel,
        // we shall verify that the certificate used to create the Session is the same as the current channel certificate.
        var old_channel_cert_thumbprint = thumbprint(session.channel.clientCertificate);
        var new_channel_cert_thumbprint = thumbprint(channel.clientCertificate);
        if (old_channel_cert_thumbprint !== new_channel_cert_thumbprint) {
            return rejectConnection(StatusCodes.BadNoValidCertificates); // not sure about this code !
        }

        // ... In addition the Server shall verify that the  Client  supplied a  UserIdentityToken  that is   identical to
        // the token currently associated with the  Session reassign session to new channel.
        if (!sameIdentityToken(session.userIdentityToken, request.userIdentityToken)) {
            return rejectConnection(StatusCodes.BadIdentityChangeNotSupported); // not sure about this code !
        }

        session.changeToChannel(channel);


    } else if (session.status === "screwed") {
        // session has been used before being activated => this should be detected and session should be dismissed.
        return rejectConnection(StatusCodes.BadSessionClosed);
    } else if (session.status === "closed") {
        console.log(" Bad Session Closed in  _on_ActivateSessionRequest".yellow.bold, authenticationToken.value.toString("hex"));
        return rejectConnection(StatusCodes.BadSessionClosed);
    }

    // verify clientSignature provided by the client
    if (!server.verifyClientSignature(session, channel, request.clientSignature, session.clientCertificate)) {
        return rejectConnection(StatusCodes.BadApplicationSignatureInvalid);
    }

    // check request.userIdentityToken is correct ( expected type and correctly formed)
    if (!server.isValidUserIdentityToken(channel, session, request.userIdentityToken)) {
        return rejectConnection(StatusCodes.BadIdentityTokenInvalid);
    }
    session.userIdentityToken = request.userIdentityToken;


    // check if user access is granted
    if (!server.isUserAuthorized(channel, session, request.userIdentityToken)) {
        return rejectConnection(StatusCodes.BadUserAccessDenied);
    }

    // extract : OPC UA part 4 - 5.6.3
    // Once used, a serverNonce cannot be used again. For that reason, the Server returns a new
    // serverNonce each time the ActivateSession Service is called.
    session.nonce = server.makeServerNonce();

    // attach session to this channel
    channel.session_nonce = session.nonce;

    session.status = "active";

    response = new ActivateSessionResponse({serverNonce: session.nonce});
    channel.send_response("MSG", response, message);

    function userIdentityTokenPasswordRemoved(userIdentityToken) {
        var a = userIdentityToken;
        // to do remove password
        return a;
    }

    // send OPCUA Event Notification
    // see part 5 : 6.4.3 AuditEventType
    //              6.4.7 AuditSessionEventType
    //              6.4.10 AuditActivateSessionEventType
    var VariantArrayType = require("lib/datamodel/variant").VariantArrayType;
    server.raiseEvent("AuditCreateSessionEventType", {
        // 6.4.3 AuditEventType
        actionTimeStamp: {dataType: "UtcTime", value: new Date()},
        status: {dataType: "Boolean", value: true},

        serverId: {dataType: "String", value: ""},

        // ClientAuditEntryId contains the human-readable AuditEntryId defined in Part 3.
        clientAuditEntryId: {dataType: "String", value: ""},

        // The ClientUserId identifies the user of the client requesting an action. The ClientUserId can be
        // obtained from the UserIdentityToken passed in the ActivateSession call.
        clientUserId: {dataType: "String", value: "cc"},

        /* AuditSessionEventType */
        sessionId: {dataType: "NodeId", value: session.sessionId},

        sourceName: {dataType: "String", value: "Session/ActivateSession"},
        clientSoftwareCertificates: {
            dataType: "SignedSoftwareCertificate",
            arrayType: VariantArrayType.Array,
            value: []
        },

        // UserIdentityToken reflects the userIdentityToken parameter of the ActivateSession Service call.
        // For Username/Password tokens the password should NOT be included.
        userIdentityToken: {
            dataType: "UserIdentityToken",
            value: userIdentityTokenPasswordRemoved(session.userIdentityToken)
        },
        secureChannelId: {dataType: "String", value: ""},
    });


};

var makeNodeId = require("lib/datamodel/nodeid").makeNodeId;
var ObjectTypeIds = require("lib/opcua_node_ids").ObjectTypeIds;


function _coerceEventType(address_space, eventType) {

    var nodeid = makeNodeId(ObjectTypeIds[eventType]);
    var eventTypeNode = address_space.findObject(nodeid);
    return eventTypeNode;
}

OPCUAServer.prototype.raiseEvent = function (eventType, options) {
    var self = this;

    var server = self.engine.address_space.findObject("Server");
    if (!server) {
        // throw new Error("OPCUAServer#raiseEvent : cannot find Server object");
        return;
    }
    var eventTypeNode = _coerceEventType(self.engine.address_space, eventType);
    if (eventTypeNode) {
        console.log("nodeid = ", eventTypeNode.nodeid);
        server.raiseEvent(eventTypeNode, options);

    }
};


/**
 * ensure that action is performed on a valid session object,
 * @method _apply_on_SessionObject
 * @private
 */
OPCUAServer.prototype._apply_on_SessionObject = function (ResponseClass, message, channel, action_to_perform) {

    assert(_.isFunction(action_to_perform));

    function sendError(statusCode) {
        return g_sendError(channel, message, ResponseClass, statusCode);
    }

    var response;
    /* istanbul ignore next */
    if (!message.session || message.session_statusCode !== StatusCodes.Good) {

        var errMessage = "INVALID SESSION  !! ";
        debugLog(errMessage.red.bold);
        response = new ResponseClass({responseHeader: {serviceResult: message.session_statusCode}});
        return channel.send_response("MSG", response, message);
    }

    assert(message.session_statusCode === StatusCodes.Good);

    // OPC UA Specification 1.02 part 4 page 26
    // When a  Session  is terminated, all outstanding requests on the  Session  are aborted and
    // Bad_SessionClosed  StatusCodes  are returned to the  Client. In addition,   the  Server  deletes the entry
    // for the  Client  from its  SessionDiagnostics Array  Variable  and notifies any other  Clients  who were
    // subscribed to this entry.
    if (message.session.status === "closed") {

        //note : use StatusCodes.BadSessionClosed , for pending message for this session
        //xx console.log("xxxxxxxxxxxxxxxxxxxxxxxxxx message.session.status ".red.bold,message.session.status.toString().cyan);
        return sendError(StatusCodes.BadSessionIdInvalid);
    }

    if (message.session.status !== "active") {

        // mark session as being screwed ! so it cannot be activated anymore
        message.session.status = "screwed";

        //note : use StatusCodes.BadSessionClosed , for pending message for this session
        return sendError(StatusCodes.BadSessionNotActivated);
    }


    // lets also reset the session watchdog so it doesn't
    // (Sessions are terminated by the Server automatically if the Client fails to issue a Service request on the Session
    // within the timeout period negotiated by the Server in the CreateSession Service response. )
    assert(_.isFunction(message.session.keepAlive));
    message.session.keepAlive();

    action_to_perform(message.session, message, channel);

};

/**
 * @method _on_CloseSessionRequest
 * @param message
 * @param channel
 * @private
 */
OPCUAServer.prototype._on_CloseSessionRequest = function (message, channel) {

    var server = this;

    var request = message.request;
    assert(request instanceof CloseSessionRequest);

    var response;

    message.session_statusCode = StatusCodes.Good;

    function sendError(statusCode) {
        return g_sendError(channel, message, CloseSessionResponse, statusCode);
    }

    // do not use _apply_on_SessionObject
    //this._apply_on_SessionObject(CloseSessionResponse, message, channel, function (session) {
    //});

    var session = message.session;
    if (!session) {
        return sendError(StatusCodes.BadSessionIdInvalid);
    }

    if (session.status === "new") {
        // session has been created but not activated !
        return sendError(StatusCodes.BadSessionNotActivated);
    }

    var deleteSubscriptions = request.deleteSubscriptions || false;
    server.engine.closeSession(request.requestHeader.authenticationToken, deleteSubscriptions);

    response = new CloseSessionResponse({});
    channel.send_response("MSG", response, message);
};

function limitInputArray(nodeArray, maxNodes) {

    assert(_.isArray(nodeArray));
    assert(_.isNumber(maxNodes));
    // limit size of nodeArray array to maxNodes
    if (maxNodes && maxNodes < nodeArray.length) {
        // clipping  nodesToRead to maxRead
        nodeArray.splice(maxNodes, nodeArray.length);
        assert(nodeArray.length === maxNodes);
        return true; // limited
    }
    return false; //
}

// browse services
OPCUAServer.prototype._on_BrowseRequest = function (message, channel) {

    var request = message.request;
    assert(request instanceof BrowseRequest);
    var server = this;
    var diagnostic = {};

    function sendError(statusCode, diagnotisc) {
        return g_sendError(channel, message, BrowseResponse, statusCode, diagnotisc);
    }

    this._apply_on_SessionObject(BrowseResponse, message, channel, function (session) {
        var response;
        // test view
        if (request.view && !request.view.viewId.isEmpty()) {
            //xx console.log("xxxx ",request.view.toString());
            //xx console.log("xxxx NodeClas",View.prototype.nodeClass);
            var theView = server.engine.findObject(request.view.viewId);
            if (theView && theView.constructor.nodeClass !== View.prototype.nodeClass) {
                // Error: theView is not a View
                diagnostic.localizedText = {text: "blah"};
                theView = null;
            }
            if (!theView) {
                return sendError(StatusCodes.BadViewIdUnknown, diagnostic);
            }
        }


        if (request.nodesToBrowse.length === 0) {
            return sendError(StatusCodes.BadNothingToDo);
        }

        // ToDo: limit results to requestedMaxReferencesPerNode
        var requestedMaxReferencesPerNode = request.requestedMaxReferencesPerNode;

        limitInputArray(request.nodesToBrowse, server.engine.serverCapabilities.operationLimits.maxNodesPerBrowse);

        var results = [];
        assert(request.nodesToBrowse[0]._schema.name === "BrowseDescription");
        results = server.engine.browse(request.nodesToBrowse);
        assert(results[0]._schema.name === "BrowseResult");

        // handle continuation point and requestedMaxReferencesPerNode
        results = results.map(function (result) {
            assert(!result.continuationPoint);
            var r = session.continuationPointManager.register(requestedMaxReferencesPerNode, result.references);
            assert(r.statusCode === StatusCodes.Good);
            r.statusCode = result.statusCode;
            return r;
        });

        response = new BrowseResponse({
            results: results,
            diagnosticInfos: null
        });
        channel.send_response("MSG", response, message);
    });
};
OPCUAServer.prototype._on_BrowseNextRequest = function (message, channel) {


    var request = message.request;
    assert(request instanceof BrowseNextRequest);
    //xx var server = this;
    function sendError(statusCode, diagnotisc) {
        return g_sendError(channel, message, BrowseNextResponse, statusCode, diagnotisc);
    }

    this._apply_on_SessionObject(BrowseNextResponse, message, channel, function (session) {

        var response;

        if (request.continuationPoints.length === 0) {
            return sendError(StatusCodes.BadNothingToDo);
        }

        // A Boolean parameter with the following values:

        var results;
        if (request.releaseContinuationPoints) {
            //releaseContinuationPoints = TRUE
            //   passed continuationPoints shall be reset to free resources in
            //   the Server. The continuation points are released and the results
            //   and diagnosticInfos arrays are empty.
            results = request.continuationPoints.map(function (continuationPoint) {
                return session.continuationPointManager.cancel(continuationPoint);
            });

        } else {
            // let extract data from continuation points

            // releaseContinuationPoints = FALSE
            //   passed continuationPoints shall be used to get the next set of
            //   browse information.
            results = request.continuationPoints.map(function (continuationPoint) {
                return session.continuationPointManager.getNext(continuationPoint);
            });
        }

        response = new BrowseNextResponse({
            results: results,
            diagnosticInfos: null
        });
        channel.send_response("MSG", response, message);
    });
};

// read services
OPCUAServer.prototype._on_ReadRequest = function (message, channel) {

    var server = this;
    var request = message.request;
    assert(request instanceof ReadRequest);
    function sendError(statusCode, diagnotisc) {
        return g_sendError(channel, message, ReadResponse, statusCode, diagnotisc);
    }

    this._apply_on_SessionObject(ReadResponse, message, channel, function (session) {

        var response;

        var results = [];

        var timestampsToReturn = request.timestampsToReturn;

        if (timestampsToReturn === TimestampsToReturn.Invalid) {
            return sendError(StatusCodes.BadTimestampsToReturnInvalid);
        }

        if (request.maxAge < 0) {
            return sendError(StatusCodes.BadMaxAgeInvalid);
        }

        if (request.nodesToRead.length <= 0) {
            return sendError(StatusCodes.BadNothingToDo);
        }

        assert(request.nodesToRead[0]._schema.name === "ReadValueId");
        assert(request.timestampsToReturn);

        // limit size of nodesToRead array to maxNodesPerRead
        limitInputArray(request.nodesToRead, server.engine.serverCapabilities.operationLimits.maxNodesPerRead);

        // ask for a refresh of asynchronous variables
        server.engine.refreshValues(request.nodesToRead, function (err) {

            assert(!err, " error not handled here , fix me");

            results = server.engine.read(request);

            assert(results[0]._schema.name === "DataValue");
            assert(results.length === request.nodesToRead.length);

            response = new ReadResponse({
                results: results,
                diagnosticInfos: null
            });
            channel.send_response("MSG", response, message);
        });

    });

};
/*
 // write services
 // OPCUA Specification 1.02 Part 3 : 5.10.4 Write
 // This Service is used to write values to one or more Attributes of one or more Nodes. For constructed
 // Attribute values whose elements are indexed, such as an array, this Service allows Clients to write
 // the entire set of indexed values as a composite, to write individual elements or to write ranges of
 // elements of the composite.
 // The values are written to the data source, such as a device, and the Service does not return until it writes
 // the values or determines that the value cannot be written. In certain cases, the Server will successfully
 // to an intermediate system or Server, and will not know if the data source was updated properly. In these cases,
 // the Server should report a success code that indicates that the write was not verified.
 // In the cases where the Server is able to verify that it has successfully written to the data source,
 // it reports an unconditional success.
 */
OPCUAServer.prototype._on_WriteRequest = function (message, channel) {

    var server = this;
    var request = message.request;
    assert(request instanceof WriteRequest);
    assert(_.isArray(request.nodesToWrite));
    function sendError(statusCode, diagnotisc) {
        return g_sendError(channel, message, WriteResponse, statusCode, diagnotisc);
    }

    var response;

    if (request.nodesToWrite.length === 0) {
        return sendError(StatusCodes.BadNothingToDo);
    }

    assert(request.nodesToWrite[0]._schema.name === "WriteValue");
    server.engine.write(request.nodesToWrite, function (err, results) {
        assert(!err);
        assert(_.isArray(results));
        assert(results.length === request.nodesToWrite.length);
        response = new WriteResponse({
            results: results,
            diagnosticInfos: null
        });
        channel.send_response("MSG", response, message);

    });

};


/*=== private
 *
 * perform the read operation on a given node for a monitored item.
 * this method DOES NOT apply to Variable Values attribute
 *
 * @param self
 * @param oldValue
 * @param node
 * @param itemToMonitor
 * @private
 */
function monitoredItem_read_and_record_value(self, oldValue, node, itemToMonitor) {

    assert(self instanceof MonitoredItem);
    //xx assert(itemToMonitor.attributeId !== AttributeIds.Value);
    var dataValue = node.readAttribute(itemToMonitor.attributeId, itemToMonitor.indexRange, itemToMonitor.dataEncoding);
    self.recordValue(dataValue, null);

    //if (dataValue.statusCode === StatusCodes.Good) {
    //    if (!are_same_values(dataValue, oldValue)) {
    //        console.log("recordValue  ", dataValue.value.value,dataValue.statusCode.toString());
    //        self.recordValue(dataValue);
    //    }
    //} else {
    //    /* istanbul ignore next */
    //    debugLog("readValue2 Error" + dataValue.statusCode.toString());
    //}
}

/*== private
 * @method monitoredItem_read_and_record_value_async
 * this method applies to Variable Values attribute
 * @param self
 * @param oldValue
 * @param node
 * @param itemToMonitor
 * @private
 */
function monitoredItem_read_and_record_value_async(self, oldValue, node, itemToMonitor) {

    assert(itemToMonitor.attributeId === AttributeIds.Value);

    // do it asynchronously
    assert(itemToMonitor.attributeId === AttributeIds.Value);
    node.readValueAsync(function (err, dataValue) {
        if (!err) {
            ///xx if (itemToMonitor.indexRange && itemToMonitor.attributeId === AttributeIds.Value) {
            ///xx     // index range requires a new read
            ///xx     dataValue = node.readAttribute(itemToMonitor.attributeId, itemToMonitor.indexRange, itemToMonitor.dataEncoding);
            ///xx }
            ///xx // todo Apply filter
            self.recordValue(dataValue, null);
        }
    });

}


function sameVariant(v1, v2) {
    return _.isEqual(v1, v2);
}

function sameDataValue(v1, v2) {
    if (v1 === v2) {
        return true;
    }
    if (v1 && !v2) {
        return false;
    }
    if (v2 && !v1) {
        return false;
    }
    return sameVariant(v1.value, v2.value) && (v1.statusCode === v2.statusCode);
}
//OPCUAServer.prototype.__findMonitoredItem = function (nodeId) {
//    var engine = this.engine;
//    /* istanbul ignore next */
//    if (!engine) {
//        return null;
//    }
//    return engine.findObject(nodeId);
//};

function build_scanning_node_function(address_space, monitoredItem, itemToMonitor) {

    //assert(address_space instanceof AddressSpace);
    assert(address_space.constructor.name === "AddressSpace");
    assert(itemToMonitor instanceof ReadValueId);

    var node = address_space.findObject(itemToMonitor.nodeId);

    /* istanbul ignore next */
    if (!node) {

        console.log(" INVALID NODE ID  , ", itemToMonitor.nodeId.toString());
        dump(itemToMonitor);
        return function () {
            return new DataValue({
                statusCode: StatusCodes.BadNodeIdUnknown,
                value: {dataType: DataType.Null, value: 0}
            });
        };
    }

    if (itemToMonitor.attributeId === AttributeIds.Value) {

        var monitoredItem_read_and_record_value_func =
            (itemToMonitor.attributeId === AttributeIds.Value && _.isFunction(node.readValueAsync)) ?
                monitoredItem_read_and_record_value_async :
                monitoredItem_read_and_record_value;

        node.on("value_changed", function (dataValue, indexRange) {
            monitoredItem.recordValue(dataValue, indexRange);
        });

        return function (oldDataValue) {
            assert(this instanceof MonitoredItem);
            return monitoredItem_read_and_record_value_func(this, oldDataValue, node, itemToMonitor);
        };


    } else {
        // Attributes, other than the  Value  Attribute, are only monitored for a change in value.
        // The filter is not used for these  Attributes. Any change in value for these  Attributes
        // causes a  Notification  to be  generated.

        // only record value when it has changed
        return function (oldDataValue) {

            var self = this;
            assert(self instanceof MonitoredItem);

            var newDataValue = node.readAttribute(itemToMonitor.attributeId);
            if (!sameDataValue(newDataValue, oldDataValue)) {
                console.log("oldDataValue ", oldDataValue ? oldDataValue.toString().cyan : null);
                console.log("newDataValue ", newDataValue.toString().yellow);
                self.recordValue(newDataValue);
            }
        };
    }
}


function prepareMonitoredItem(address_space, monitoredItem) {
    var itemToMonitor = monitoredItem.itemToMonitor;
    // make sure we read initial value some time in the very near future
    setImmediate(function () {
        readNodeFunc.call(monitoredItem, null);
    });
    var readNodeFunc = build_scanning_node_function(address_space, monitoredItem, itemToMonitor);
    monitoredItem.on("samplingEvent", readNodeFunc);
}


OPCUAServer.MAX_SUBSCRIPTION = 100;

// subscription services
OPCUAServer.prototype._on_CreateSubscriptionRequest = function (message, channel) {

    var server = this;
    var engine = server.engine;
    var address_space = engine.address_space;

    var request = message.request;
    assert(request instanceof CreateSubscriptionRequest);
    function sendError(statusCode, diagnotisc) {
        return g_sendError(channel, message, CreateSubscriptionResponse, statusCode, diagnotisc);
    }

    this._apply_on_SessionObject(CreateSubscriptionResponse, message, channel, function (session) {

        if (session.currentSubscriptionCount >= OPCUAServer.MAX_SUBSCRIPTION) {
            return sendError(StatusCodes.BadTooManySubscriptions);
        }

        var subscription = session.createSubscription(request);

        subscription.on("monitoredItem", function (monitoredItem) {
            prepareMonitoredItem(address_space, monitoredItem);
        });


        var response = new CreateSubscriptionResponse({
            subscriptionId: subscription.id,
            revisedPublishingInterval: subscription.publishingInterval,
            revisedLifetimeCount: subscription.lifeTimeCount,
            revisedMaxKeepAliveCount: subscription.maxKeepAliveCount
        });
        channel.send_response("MSG", response, message);
    });
};

OPCUAServer.prototype._on_DeleteSubscriptionsRequest = function (message, channel) {

    var request = message.request;
    assert(request instanceof DeleteSubscriptionsRequest);

    function sendError(statusCode, diagnotisc) {
        return g_sendError(channel, message, DeleteSubscriptionsResponse, statusCode, diagnotisc);
    }

    this._apply_on_SessionObject(DeleteSubscriptionsResponse, message, channel, function (session) {

        var response;

        if (request.subscriptionIds.length === 0) {
            return sendError(StatusCodes.BadNothingToDo);
        }

        var results = request.subscriptionIds.map(function (subscriptionId) {
            return session.deleteSubscription(subscriptionId);
        });
        response = new DeleteSubscriptionsResponse({
            results: results
        });
        channel.send_response("MSG", response, message);
    });
};

OPCUAServer.prototype.prepare = function (message, channel) {

    var server = this;
    var request = message.request;

    // --- check that session is correct
    var authenticationToken = request.requestHeader.authenticationToken;
    var session = server.getSession(authenticationToken, /*activeOnly*/true);
    message.session = session;
    if (!session) {
        message.session_statusCode = StatusCodes.BadSessionIdInvalid;
        return;
    }

    //xx console.log("xxxx channel ",channel.secureChannelId,session.secureChannelId);
    // --- check that provided session matches session attached to channel
    if (channel.secureChannelId !== session.secureChannelId) {
        if (!(request instanceof ActivateSessionRequest)) {
            console.log("ERROR: channel.secureChannelId !== session.secureChannelId".red.bgWhite, channel.secureChannelId, session.secureChannelId);
            //xx console.log("trace",(new Error()).stack);
        }
        message.session_statusCode = StatusCodes.BadSecureChannelIdInvalid;

    } else if (channel.session_nonce === session.nonce) {
        message.session_statusCode = StatusCodes.Good;
    } else {
        // session ma y have been moved to a different channel
        message.session_statusCode = StatusCodes.BadSecureChannelIdInvalid;
    }
};


OPCUAServer.prototype._on_CreateMonitoredItemsRequest = function (message, channel) {

    var server = this;
    var engine = server.engine;
    var address_space = engine.address_space;

    var request = message.request;
    assert(request instanceof CreateMonitoredItemsRequest);
    function sendError(statusCode, diagnotisc) {
        return g_sendError(channel, message, CreateMonitoredItemsResponse, statusCode, diagnotisc);
    }

    this._apply_on_SessionObject(CreateMonitoredItemsResponse, message, channel, function (session) {

        var response;

        var subscription = session.getSubscription(request.subscriptionId);
        if (!subscription) {
            return sendError(StatusCodes.BadSubscriptionIdInvalid);
        }

        subscription.resetLifeTimeAndKeepAliveCounters();

        var timestampsToReturn = request.timestampsToReturn;

        if (timestampsToReturn === TimestampsToReturn.Invalid) {
            return sendError(StatusCodes.BadTimestampsToReturnInvalid);
        }
        if (request.itemsToCreate.length === 0) {
            return sendError(StatusCodes.BadNothingToDo);
        }

        var results = request.itemsToCreate.map(
            subscription.createMonitoredItem.bind(subscription, address_space, timestampsToReturn));

        response = new CreateMonitoredItemsResponse({
            responseHeader: {serviceResult: StatusCodes.Good},
            results: results
            //,diagnosticInfos: []
        });
        channel.send_response("MSG", response, message);

    });

};

var ModifySubscriptionRequest = subscription_service.ModifySubscriptionRequest;
var ModifySubscriptionResponse = subscription_service.ModifySubscriptionResponse;

OPCUAServer.prototype._on_ModifySubscriptionRequest = function (message, channel) {

    var request = message.request;
    assert(request instanceof ModifySubscriptionRequest);
    function sendError(statusCode, diagnotisc) {
        return g_sendError(channel, message, ModifySubscriptionResponse, statusCode, diagnotisc);
    }

    this._apply_on_SessionObject(ModifySubscriptionResponse, message, channel, function (session) {

        var subscription = session.getSubscription(request.subscriptionId);
        var response;

        if (!subscription) {
            return sendError(StatusCodes.BadSubscriptionIdInvalid);
        }

        subscription.resetLifeTimeAndKeepAliveCounters();

        subscription.modify(request);

        response = new ModifySubscriptionResponse({
            revisedPublishingInterval: subscription.publishingInterval,
            revisedLifetimeCount: subscription.lifeTimeCount,
            revisedMaxKeepAliveCount: subscription.maxKeepAliveCount
        });
        channel.send_response("MSG", response, message);
    });
};


OPCUAServer.prototype._on_ModifyMonitoredItemsRequest = function (message, channel) {
    var request = message.request;
    assert(request instanceof ModifyMonitoredItemsRequest);

    function sendError(statusCode) {
        return g_sendError(channel, message, ModifyMonitoredItemsResponse, statusCode);
    }

    this._apply_on_SessionObject(ModifyMonitoredItemsResponse, message, channel, function (session) {

        var subscription = session.getSubscription(request.subscriptionId);
        var response;

        if (!subscription) {
            return sendError(StatusCodes.BadSubscriptionIdInvalid);
        }
        subscription.resetLifeTimeAndKeepAliveCounters();

        var timestampsToReturn = request.timestampsToReturn;
        if (timestampsToReturn === TimestampsToReturn.Invalid) {
            return sendError(StatusCodes.BadTimestampsToReturnInvalid);
        }
        if (request.itemsToModify.length === 0) {
            return sendError(StatusCodes.BadNothingToDo);
        }

        var itemsToModify = request.itemsToModify; // MonitoredItemModifyRequest

        function modifyMonitoredItem(item) {

            var monitoredItemId = item.monitoredItemId;
            var monitoredItem = subscription.getMonitoredItem(monitoredItemId);
            if (!monitoredItem) {
                return new MonitoredItemModifyResult({statusCode: StatusCodes.BadMonitoredItemIdInvalid});
            }
            return monitoredItem.modify(timestampsToReturn, item.requestedParameters);
        }

        var results = itemsToModify.map(modifyMonitoredItem);
        response = new ModifyMonitoredItemsResponse({
            results: results
        });

        channel.send_response("MSG", response, message);


    });

};

OPCUAServer.prototype._on_PublishRequest = function (message, channel) {

    var request = message.request;
    assert(request instanceof PublishRequest);

    this._apply_on_SessionObject(PublishResponse, message, channel, function (session) {
        assert(session);
        assert(session.publishEngine); // server.publishEngine doesn't exists, OPCUAServer has probably shut down already
        session.publishEngine._on_PublishRequest(request, function (request, response) {
            channel.send_response("MSG", response, message);
        });
    });
};


OPCUAServer.prototype._on_SetPublishingModeRequest = function (message, channel) {

    var request = message.request;
    assert(request instanceof SetPublishingModeRequest);
    function sendError(statusCode, diagnotisc) {
        return g_sendError(channel, message, SetPublishingModeResponse, statusCode, diagnotisc);
    }

    this._apply_on_SessionObject(SetPublishingModeResponse, message, channel, function (session) {

        var response;
        var publishingEnabled = request.publishingEnabled;
        var subscriptionIds = request.subscriptionIds;

        var results = subscriptionIds.map(function (subscriptionId) {

            var subscription = session.getSubscription(subscriptionId);
            if (!subscription) {
                return StatusCodes.BadSubscriptionIdInvalid;
            }
            subscription.resetLifeTimeAndKeepAliveCounters();

            return subscription.setPublishingMode(publishingEnabled);
        });

        response = new SetPublishingModeResponse({
            results: results,
            diagnosticInfos: null
        });
        channel.send_response("MSG", response, message);
    });
};


OPCUAServer.prototype._on_DeleteMonitoredItemsRequest = function (message, channel) {

    var request = message.request;
    assert(request instanceof DeleteMonitoredItemsRequest);
    function sendError(statusCode) {
        return g_sendError(channel, message, DeleteMonitoredItemsResponse, statusCode);
    }

    this._apply_on_SessionObject(DeleteMonitoredItemsResponse, message, channel, function (session) {

        var response;

        var subscriptionId = request.subscriptionId;
        assert(subscriptionId !== null);

        var subscription = session.getSubscription(subscriptionId);
        if (!subscription) {
            debugLog("Cannot find subscription ", subscriptionId);
            return sendError(StatusCodes.BadSubscriptionIdInvalid);
        }

        subscription.resetLifeTimeAndKeepAliveCounters();

        if (request.monitoredItemIds.length === 0) {
            return sendError(StatusCodes.BadNothingToDo);
        }

        var results = request.monitoredItemIds.map(function (monitoredItemId) {
            return subscription.removeMonitoredItem(monitoredItemId);
        });

        response = new DeleteMonitoredItemsResponse({
            results: results,
            diagnosticInfos: null
        });

        channel.send_response("MSG", response, message);
    });
};

OPCUAServer.prototype._on_RepublishRequest = function (message, channel) {

    var request = message.request;
    assert(request instanceof RepublishRequest);

    function sendError(statusCode) {
        return g_sendError(channel, message, RepublishResponse, statusCode);
    }

    this._apply_on_SessionObject(RepublishResponse, message, channel, function (session) {

        var response;

        var subscription = session.getSubscription(request.subscriptionId);

        if (!subscription) {
            return sendError(StatusCodes.BadSubscriptionIdInvalid);
        }
        subscription.resetLifeTimeAndKeepAliveCounters();

        var retransmitSequenceNumber = request.retransmitSequenceNumber;

        var msgSequence = subscription.getMessageForSequenceNumber(retransmitSequenceNumber);

        if (!msgSequence) {
            return sendError(StatusCodes.BadMessageNotAvailable);
        }

        response = new RepublishResponse({
            responseHeader: {
                serviceResult: StatusCodes.Good
            },
            notificationMessage: msgSequence.notification
        });

        channel.send_response("MSG", response, message);
    });
};

var SetMonitoringModeRequest = subscription_service.SetMonitoringModeRequest;
var SetMonitoringModeResponse = subscription_service.SetMonitoringModeResponse;

// Bad_NothingToDo
// Bad_TooManyOperations
// Bad_SubscriptionIdInvalid
// Bad_MonitoringModeInvalid
OPCUAServer.prototype._on_SetMonitoringModeRequest = function (message, channel) {

    var request = message.request;
    assert(request instanceof SetMonitoringModeRequest);
    function sendError(statusCode) {
        return g_sendError(channel, message, SetMonitoringModeResponse, statusCode);
    }

    this._apply_on_SessionObject(RepublishResponse, message, channel, function (session) {
        var response;

        var subscription = session.getSubscription(request.subscriptionId);

        if (!subscription) {
            return sendError(StatusCodes.BadSubscriptionIdInvalid);
        }
        subscription.resetLifeTimeAndKeepAliveCounters();

        if (request.monitoredItemIds.length === 0) {
            return sendError(StatusCodes.BadNothingToDo);
        }

        var monitoringMode = request.monitoringMode;

        if (monitoringMode === subscription_service.MonitoringMode.Invalid) {
            return sendError(StatusCodes.BadMonitoringModeInvalid);
        }

        var results = request.monitoredItemIds.map(function (monitoredItemId) {

            var monitoredItem = subscription.getMonitoredItem(monitoredItemId);
            if (!monitoredItem) {
                return StatusCodes.BadMonitoredItemIdInvalid;
            }
            monitoredItem.setMonitoringMode(monitoringMode);
            return StatusCodes.Good;
        });

        response = new SetMonitoringModeResponse({
            results: results
        });
        channel.send_response("MSG", response, message);
    });

};

// _on_TranslateBrowsePathsToNodeIds service
OPCUAServer.prototype._on_TranslateBrowsePathsToNodeIdsRequest = function (message, channel) {

    var request = message.request;
    assert(request instanceof TranslateBrowsePathsToNodeIdsRequest);
    var server = this;

    function sendError(statusCode) {
        return g_sendError(channel, message, TranslateBrowsePathsToNodeIdsResponse, statusCode);
    }

    this._apply_on_SessionObject(TranslateBrowsePathsToNodeIdsResponse, message, channel, function (session) {

        if (request.browsePath.length === 0) {
            return sendError(StatusCodes.BadNothingToDo);
        }

        var browsePathResults = request.browsePath.map(function (browsePath) {
            return server.engine.browsePath(browsePath);
        });
        var response = new TranslateBrowsePathsToNodeIdsResponse({
            results: browsePathResults,
            diagnosticInfos: null
        });
        channel.send_response("MSG", response, message);

    });

};


// Symbolic Id                   Description
//----------------------------  ----------------------------------------------------------------------------------------
// Bad_NodeIdInvalid             Used to indicate that the specified object is not valid.
//
// Bad_NodeIdUnknown             Used to indicate that the specified object is not valid.
//
// Bad_ArgumentsMissing          The client did not specify all of the input arguments for the method.
// Bad_UserAccessDenied
//
// Bad_MethodInvalid             The method id does not refer to a method for the specified object.
// Bad_OutOfRange                Used to indicate that an input argument is outside the acceptable range.
// Bad_TypeMismatch              Used to indicate that an input argument does not have the correct data type.
//                               A ByteString is structurally the same as a one dimensional array of Byte.
//                               A server shall accept a ByteString if an array of Byte is expected.
// Bad_NoCommunication

var getMethodDeclaration_ArgumentList = require("lib/datamodel/argument_list").getMethodDeclaration_ArgumentList;
var verifyArguments_ArgumentList = require("lib/datamodel/argument_list").verifyArguments_ArgumentList;

function callMethod(session, callMethodRequest, callback) {
    /* jshint validthis: true */
    var server = this;
    var address_space = server.engine.address_space;

    var objectId = callMethodRequest.objectId;
    var methodId = callMethodRequest.methodId;
    var inputArguments = callMethodRequest.inputArguments;

    assert(objectId instanceof NodeId);
    assert(methodId instanceof NodeId);


    var response = getMethodDeclaration_ArgumentList(address_space, objectId, methodId);

    if (response.statusCode !== StatusCodes.Good) {
        return callback(null, {statusCode: response.statusCode});
    }
    var methodDeclaration = response.methodDeclaration;

    // verify input Parameters
    var methodInputArguments = methodDeclaration.getInputArguments();

    response = verifyArguments_ArgumentList(methodInputArguments, inputArguments);
    if (response.statusCode !== StatusCodes.Good) {
        return callback(null, response);
    }

    var methodObj = address_space.findObject(methodId);
    // invoke method on object
    var context = {
        session: session
    };

    methodObj.execute(inputArguments, context, function (err, callMethodResponse) {

        /* istanbul ignore next */
        if (err) {
            return callback(err);
        }

        callMethodResponse.inputArgumentResults = response.inputArgumentResults;
        assert(callMethodResponse.statusCode);

        if (callMethodResponse.statusCode === StatusCodes.Good) {
            assert(_.isArray(callMethodResponse.outputArguments));
        }

        assert(_.isArray(callMethodResponse.inputArgumentResults));
        assert(callMethodResponse.inputArgumentResults.length === methodInputArguments.length);

        return callback(null, callMethodResponse);
    });

}

var maximumOperationInCallRequest = 1000;


// Call Service Result Codes
// Symbolic Id Description
// Bad_NothingToDo       See Table 165 for the description of this result code.
// Bad_TooManyOperations See Table 165 for the description of this result code.
//
OPCUAServer.prototype._on_CallRequest = function (message, channel) {

    var server = this;
    var request = message.request;
    assert(request instanceof CallRequest);
    function sendError(statusCode) {
        return g_sendError(channel, message, CallResponse, statusCode);
    }

    this._apply_on_SessionObject(RepublishResponse, message, channel, function (session) {

        var response;

        if (request.methodsToCall.length === 0) {
            return sendError(StatusCodes.BadNothingToDo);
        }
        if (request.methodsToCall.length >= maximumOperationInCallRequest) {
            return sendError(StatusCodes.BadTooManyOperations);
        }

        async.map(request.methodsToCall, callMethod.bind(server, session), function (err, results) {
            assert(!err);
            assert(_.isArray(results));
            response = new CallResponse({results: results});
            channel.send_response("MSG", response, message);

        }, function (err) {
            /* istanbul ignore next */
            if (err) {
                channel.send_error_and_abort(StatusCodes.BadInternalError, err.message, "", function () {
                });
            }
        });
    });


};


OPCUAServer.prototype._on_RegisterNodesRequest = function (message, channel) {
    var request = message.request;
    assert(request instanceof RegisterNodesRequest);
    //xx var server = this;

    this._apply_on_SessionObject(RegisterNodesResponse, message, channel, function (/*session*/) {

        var response;

        if (request.nodesToRegister.length === 0) {
            response = new RegisterNodesResponse({responseHeader: {serviceResult: StatusCodes.BadNothingToDo}});
            return channel.send_response("MSG", response, message);
        }

        response = new RegisterNodesResponse({
            registeredNodeIds: request.nodesToRegister,
        });
        channel.send_response("MSG", response, message);
    });
};
OPCUAServer.prototype._on_UnregisterNodesRequest = function (message, channel) {

    var request = message.request;
    assert(request instanceof UnregisterNodesRequest);
    //xx var server = this;

    this._apply_on_SessionObject(UnregisterNodesResponse, message, channel, function (session) {

        var response;

        if (request.nodesToUnregister.length === 0) {
            response = new UnregisterNodesResponse({responseHeader: {serviceResult: StatusCodes.BadNothingToDo}});
            return channel.send_response("MSG", response, message);
        }

        response = new UnregisterNodesResponse({});

        channel.send_response("MSG", response, message);
    });

};

/**
 * @method registerServer
 * @async
 * @param discovery_server_endpointUrl
 * @param callback
 */
OPCUAServer.prototype._registerServer = function (discovery_server_endpointUrl, isOnLine, outer_callback) {


    function findSecureEndpoint(endpoints) {
        var endpoint = endpoints.filter(function (e) {
            return e.securityMode === MessageSecurityMode.SIGNANDENCRYPT;
        });
        if (endpoint.length === 0) {
            endpoint = endpoints.filter(function (e) {
                return e.securityMode === MessageSecurityMode.SIGN;
            });
        }
        if (endpoint.length === 0) {
            endpoint = endpoints.filter(function (e) {
                return e.securityMode === MessageSecurityMode.NONE;
            });
        }
        return endpoint[0];
    }

    var async = require("async");
    var MessageSecurityMode = endpoints_service.MessageSecurityMode;
    var securityPolicy_m = require("lib/misc/security_policy");
    var SecurityPolicy = securityPolicy_m.SecurityPolicy;

    var OPCUAClientBase = require("lib/client/client_base").OPCUAClientBase;

    var self = this;
    assert(self.serverType, " must have a valid server Type");

    var client = new OPCUAClientBase();

    var discoveryServerCertificate = null;

    async.series([

        function (callback) {

            client.connect(discovery_server_endpointUrl, callback);

        },
        function (callback) {

            client.getEndpointsRequest(function (err, endpoints) {
                if (!err) {

                    var endpoint = findSecureEndpoint(endpoints);
                    assert(endpoint);
                    assert(endpoint.serverCertificate);
                    discoveryServerCertificate = endpoint.serverCertificate;
                }
                callback(err);
            });
        },


        function (callback) {
            client.disconnect(callback);
        },

        function (callback) {


            var options = {
                securityMode: MessageSecurityMode.SIGN,
                securityPolicy: SecurityPolicy.Basic128Rsa15,
                serverCertificate: discoveryServerCertificate
            };
            client = new OPCUAClientBase(options);

            client.connect(discovery_server_endpointUrl, function (err) {
                if (!err) {
                    callback(err);
                } else {
                    console.log(" cannot register server to discovery server " + discovery_server_endpointUrl);
                    console.log("   " + err.message);
                    console.log(" make sure discovery server is up and running.");
                    client.disconnect(function () {
                        callback(err);
                    });
                }
            });
        },

        function (callback) {

            var discoveryUrls = self.getDiscoveryUrls();

            var request = new RegisterServerRequest({
                server: {

                    // The globally unique identifier for the Server instance. The serverUri matches
                    // the applicationUri from the ApplicationDescription defined in 7.1.
                    serverUri: self.serverInfo.applicationUri,

                    // The globally unique identifier for the Server product.
                    productUri: self.serverInfo.productUri,
                    serverNames: [
                        {locale: "en", text: self.serverInfo.productName}
                    ],
                    serverType: self.serverType,
                    gatewayServerUri: null,
                    discoveryUrls: discoveryUrls,
                    semaphoreFilePath: null,
                    isOnline: isOnLine
                }
            });

            //xx console.log("request",request.toString());

            client.performMessageTransaction(request, function (err, response) {
                if (!err) {
                    // RegisterServerResponse
                    assert(response instanceof RegisterServerResponse);
                }
                callback(err);
            });
        },

        function (callback) {
            client.disconnect(callback);
        }

    ], function (err) {
        if (err) {
            console.log("error ", err.message);
        }
        outer_callback(err);
    });

};

OPCUAServer.prototype.registerServer = function (discovery_server_endpointUrl, callback) {
    this._registerServer(discovery_server_endpointUrl, true, callback);
};

OPCUAServer.prototype.unregisterServer = function (discovery_server_endpointUrl, callback) {
    this._registerServer(discovery_server_endpointUrl, false, callback);
};


exports.OPCUAServerEndPoint = OPCUAServerEndPoint;
exports.OPCUAServer = OPCUAServer;
