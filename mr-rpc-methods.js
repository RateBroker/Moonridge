var rpc = require('socket.io-rpc');
var _ = require('lodash');
var Promise = require('bluebird');
var eventNames = require('./schema-events').eventNames;
var queryBuilder = require('./query-builder');
var populateWithClientQuery = require('./utils/populate-doc-util');
var maxLQsPerClient = 100;
var logger = require('./utils/logger');
/**
 *
 * @param {Model} model Moonridge model
 * @param {Schema} schema mongoose schema
 * @param {Object} opts same as for regNewModel in ./main.js
 */
var expose = function (model, schema, opts) {
    var liveQueries = {};
    opts = opts || {};
    var modelName = model.modelName;

    if (opts.dataTransform) {
        logger.info('dataTransform method is overridden for model "%s"', modelName);
    } else {
        /**
         * similar purpose as accessControlQueryModifier but works not on query, but objects, usable whenever we are sending
         * new doc to client without querying
         * @param {Object} doc just JS object, not a real mongoose doc
         * @param {String} op operation that is about to happen, possible values are: 'R', 'W'
         * @param {Socket} socket
         * @returns {*}
         */
        opts.dataTransform = function deleteUnpermittedProps(doc, op, socket) {
            var userPL = socket.manager.user.privilige_level;

            var pathPs = schema.pathPermissions;
            var docClone = _.clone(doc);

            for (var prop in pathPs) {
                var perm = pathPs[prop];
                if (perm[op] && perm[op] > userPL) {
                    delete docClone[prop];
                }
            }
            return docClone;
        }
    }


    var getIndexInSorted = require('./utils/indexInSortedArray');

    model.onCUD(function (mDoc, evName) {   // will be called by schema's event firing
        var doc = mDoc.toObject();
        Object.keys(liveQueries).forEach(function (LQString) {
            var LQ = liveQueries[LQString];

            var syncLogic = function () {
                var cQindex = LQ.getIndexById(doc._id); //index of current doc in the query

                if (evName === 'remove' && LQ.docs[cQindex]) {

                    LQ.docs.splice(cQindex, 1);
                    LQ.callClientListeners(doc, evName, false);

                    if (LQ.clientQuery.limit) {
                        var skip = 0;
                        if (LQ.clientQuery.skip) {
                            skip = LQ.clientQuery.skip[0];
                        }
                        skip += LQ.clientQuery.limit[0] - 1;
                        model.find(LQ.mQuery).lean().skip(skip).limit(1)
                            .exec(function(err, docArr) {
                                if (docArr.length === 1) {
                                    var toFillIn = docArr[0];
                                    if (toFillIn) {
                                        LQ.docs.push(toFillIn);
                                        LQ.callClientListeners(toFillIn, 'push');
                                    }
                                }

                            }
                        );

                    }

                } else {
                    var checkQuery = model.findOne(LQ.mQueryNoSelects);
                    checkQuery.where('_id').equals(doc._id).select('_id').exec(function(err, checkedDoc) {
                            if (err) {
                                logger.error(err);
                            }
                            if (checkedDoc) {   //doc satisfies the query
                                var qDoc;
                                if (LQ.clientQuery.populate) {
                                    qDoc = mDoc;   //if query has populate utilised, then we have to use the result from checkQuery as a doc
                                } else {
                                    qDoc = doc;
                                }
                                if (LQ.clientQuery.sort) {
                                    var sortBy = LQ.clientQuery.sort[0].split(' ');	//check for string is performed on query initialization
                                    var index;
                                    if (evName === 'create') {
                                        if (cQindex === -1) {
                                            index = getIndexInSorted(qDoc, LQ.docs, sortBy);
                                            LQ.docs.splice(index, 0, qDoc);
                                            if (LQ.clientQuery.limit) {
                                                if (LQ.docs.length > LQ.clientQuery.limit[0]) {
                                                    LQ.docs.splice(LQ.docs.length - 1, 1);

                                                }
                                            }

                                        }
                                    }
                                    if (evName === 'update') {
                                        index = getIndexInSorted(qDoc, LQ.docs, sortBy);

                                        if (cQindex === -1) {
                                            LQ.docs.splice(index, 0, qDoc);    //insert the document
                                        } else {
                                            if (cQindex !== index) {
                                                if (cQindex < index) {  // if we remove item before, the whole array shifts, so we have to compensate index by 1.
                                                    LQ.docs.splice(cQindex, 1);
                                                    LQ.docs.splice(index - 1, 0, qDoc);
                                                } else {
                                                    LQ.docs.splice(cQindex, 1);
                                                    LQ.docs.splice(index, 0, qDoc);
                                                }

                                            } else {
                                                LQ.docs[index] = qDoc;
                                            }
                                        }

                                    }
                                    if (_.isNumber(index)) {
                                        LQ.callClientListeners(qDoc, evName, index);
                                    }

                                } else {
                                    if (evName === 'create') {
                                        if (cQindex === -1) {
                                            LQ.docs.push(qDoc);
                                            LQ.callClientListeners(qDoc, evName, null);
                                        }
                                    }
                                    if (evName === 'update') {
                                        if (cQindex === -1) {
                                            LQ.docs.push(qDoc);
                                            LQ.callClientListeners(qDoc, evName, true);	//doc wasn't in the result, but after update is

                                        } else {
                                            LQ.callClientListeners(qDoc, evName, null);	//doc is still in the query result on the same index

                                        }
                                    }

                                }
                            } else {
                                if (evName === 'update' && cQindex !== -1) {
                                    LQ.docs.splice(cQindex, 1);
                                    LQ.callClientListeners(doc, evName, false);		//doc was in the result, but after update is no longer
                                }
                            }
                        }
                    );
                }
            };
            if (LQ.firstExecDone) {
                syncLogic();
            } else {
                LQ.firstExecPromise.then(syncLogic);
            }

        });

    });

    var notifySubscriber = function (clientPubMethod) {
        return function (doc, evName) {   // will be called by schema's event firing
            clientPubMethod(doc, evName);
        }

    };

    function unsubscribe(id, event) {  //accepts same args as findFn
        var res = model.off(id, event);
        if (res) {
            delete this.mrEventIds[event];
        }
        return res;
    }

    /**
     * @param {Socket} socket
     */
    function unsubscribeAll(socket) {
        var soc = socket || this;
        var mrEventIds = soc.mrEventIds;
        for (var eN in mrEventIds) {
            unsubscribe.call(soc, mrEventIds[eN], eN);
        }
    }

    function subscribe(evName) {
        if (evName) {
            var socket = this;
            if (!socket.mrEventIds) {
                socket.mrEventIds = {};

                socket.on('disconnect', function () {
                    unsubscribeAll(socket);
                });
            }
            var existing = this.mrEventIds;
            if (existing && existing[evName]) {
                // event already subscribed, we don't want to support more than 1 remote listener so we unregister the old one
                unsubscribe(existing[evName], evName);
            }

            var clFns = socket.cRpcChnl;

            var evId = model.on(evName, notifySubscriber(clFns.pub, socket));

            socket.mrEventIds[evName] = evId;

            return evId;
        } else {
            throw new Error('event must be specified when subscribing to it');
        }

    }

    function subscribeAll(query) {
        var evIds = {};
        var socket = this;
        eventNames.forEach(function (name) {
            evIds[name] = subscribe.call(socket, name, query);
        });
        return evIds;
    }

    if (!opts.checkPermission) {
        /**
         *
         * @param {String} op operation to check, can be 'C','R', 'U', 'D'
         * @param socketContext
         * @param {Document} [doc]
         * @returns {bool} true when user has permission, false when not
         */
        opts.checkPermission = function (socketContext, op, doc) {
            var PL; //privilige level
            try{
                PL = socketContext.manager.user.privilige_level;
            }catch(e){
                PL = 0;
            }

            if (doc && op !== 'C') {   //if not creation, with creation only priviliges apply
                if (doc.owner && doc.owner.toString() === socketContext.manager.user.id) {
                    return true;    // owner does not need any permissions
                }
                if (doc.id === socketContext.manager.user.id) {
                    return true;    //user modifying himself also has permissions
                }
            }

            if (this.permissions && this.permissions[op]) {
                if (PL < this.permissions[op]) {
                    return false;
                }
            }
            return true;
        };
    } else {
        logger.info('checkPermission method is overridden for model "%s"', modelName);
    }


    /**
     *  This function should always modify the query so that no one sees properties that they are not allowed to see,
     *  the query is modified right on the input and not somewhere later because then we get less variation and therefore less queries created
     *  and checked on the server
     * @param {Object} clQuery object parsed from stringified argument
     * @param {Schema} schema mongoose schema
     * @param {Number} userPL user privilege level
     * @param {String} op
     * @returns {Object}
     */
    function accessControlQueryModifier(clQuery, schema, userPL, op) { // guards the properties that are marked with higher required permissions for reading
        var pathPs = schema.pathPermissions;
        var select;
        if (clQuery.select) {
            select = clQuery.select[0];
        } else {
            select = {};
        }
        if (_.isString(select)) {
            //in this case, we need to parse the string and return the object notation
            var props = select.split(' ');
            var i = props.length;
            while(i--){
                var clProp = props[i];
                if (clProp[0] === '-') {
                    clProp = clProp.substr(1);
                    select[clProp] = 0;
                } else {
                    select[clProp] = 1;
                }
            }
        }
        for (var prop in pathPs) {
            var perm = pathPs[prop];
            if (perm[op] && perm[op] > userPL) {
                select[prop] = 0;
            }
        }

        clQuery.select = [select]; //after modifying the query, we just put it back as array so that we can call it with apply
        return clQuery;
    }

    /**
     * @param {String} qKey
     * @param {Mongoose.Query} mQuery
     * @param {Object} clientQuery
     * @returns {Object}
     * @constructor
     */
    function LiveQuery(qKey, mQuery, clientQuery) {
        this.docs = [];
        this.listeners = {};
        this.mQuery = mQuery;   //mongoose query
        if (clientQuery.select) {
            var clQueryNS = _.clone(clientQuery);
            delete clQueryNS.select;
            this.mQueryNoSelects = queryBuilder(model, clQueryNS);   //mongoose query
        } else {
            this.mQueryNoSelects = mQuery;   //mongoose query
        }
        this.qKey = qKey;
        this.clientQuery = clientQuery; //serializable client query object
        return this;
    }

    LiveQuery.prototype =  {
        destroy: function () {
            delete liveQueries[this.qKey];
        },
        /**
         *
         * @param {Document.Id} id
         * @returns {Number} -1 when not found
         */
        getIndexById: function (id) {
            id = id.id;
            var i = this.docs.length;
            while(i--)
            {
                var doc = this.docs[i];
                if (doc && doc._id.id === id) {
                    return i;
                }
            }
            return i;
        },
        /**
         *
         * @param {Object|Mongoose.Document} doc
         * @param {String} evName
         * @param {Boolean|Number|null} isInResult when number, indicates an index where the doc should be inserted
         */
        callClientListeners: function (doc, evName, isInResult) {
            var self = this;
            if (this.clientQuery.populate && doc.populate) {
                populateWithClientQuery(doc, this.clientQuery.populate, function (err, populated) {
                    self._distributeChange(populated.toObject(), evName, isInResult);
                });

            } else {
                self._distributeChange(doc, evName, isInResult);
            }

        },
        _distributeChange: function (doc, evName, isInResult) {
            logger.info('doc %s event %s, pos param: ' + isInResult, doc._id, evName);
            for (var socketId in this.listeners) {
                var listener = this.listeners[socketId];
                var toSend = null;
                if (listener.qOpts.count) {
                    // we don't need to send a doc when query is a count query
                } else {
                    if (evName === 'remove') {
                        toSend = doc._id.toString();	//remove needs only _id
                    } else {
                        toSend = doc;
                    }
                }

                toSend = opts.dataTransform(toSend, 'R', listener.socket);
                listener.rpcChannel[evName](listener.clIndex, toSend, isInResult);
            }
        },
        /**
         * removes a socket listener from liveQuery
         * @param socket
         */
        removeListener: function (socket) {
            if (this.listeners[socket.id]) {
                delete this.listeners[socket.id];
                if (Object.keys(this.listeners).length === 0) {
                    this.destroy()
                }
            } else {
                return new Error('no listener present on');
            }
        }
    };

    function validateClientQuery(clientQuery) {	//errors are forwarded to client
        //TODO check query for user priviliges
        if (clientQuery.sort){
            if (clientQuery.count) {
                throw new Error('Mongoose does not support sort and count in one query');
            }
            if(!_.isString(clientQuery.sort[0])) {
                throw new Error('only string notation for sort method is supported for liveQueries');
            }
        }
    }


    var channel = {
        /**
         *
         * @param {Object} clientQuery
         * @returns {Promise} from executing the mongoose.Query
         */
        query: function (clientQuery) {
            try{
                validateClientQuery(clientQuery);
            }catch(e){
                return e;
            }
            if (!opts.checkPermission(this, 'R')) {
                return new Error('You lack a privilege to read this document');
            }
            accessControlQueryModifier(clientQuery,schema, this.manager.user.privilige_level, 'R');
            clientQuery.lean = []; // this should make query always lean
            var mQuery = queryBuilder(model, clientQuery);
            return mQuery.exec();
        },
        //unsubscribe
        unsub: unsubscribe,
        unsubAll: unsubscribeAll,
        unsubLQ: function (index) {	//when client uses stop method on LQ, this method gets called
            var LQ = this.registeredLQs[index];
            if (LQ) {
                delete this.registeredLQs[index];
                LQ.removeListener(this);
                return true;
            } else {
                return new Error('Index param in LQ unsubscribe is not valid!');
            }
        },
        /**
         * @param {Object} clientQuery object to be parsed by queryBuilder, consult mongoose query.js docs for reference
         * @param {Number} LQIndex
         * @returns {Promise} from mongoose query, resolves with an array of documents
         */
        liveQuery: function (clientQuery, LQIndex) {
            try{
                validateClientQuery(clientQuery);
            }catch(e){
                return e;
            }
            if (!opts.checkPermission(this, 'R')) {
                return new Error('You lack a privilege to read this document');
            }
            if (!clientQuery) {
                clientQuery = {};
            }
            def = Promise.defer();
            if (!clientQuery.count) {
                accessControlQueryModifier(clientQuery, schema, this.manager.user.privilige_level, 'R');
            }

            var queryOptions = {};
            var moveParamToQueryOptions = function (param) {
                if (clientQuery.hasOwnProperty(param)) {
                    queryOptions[param] = clientQuery[param];
                    delete clientQuery[param];
                }
            };
            moveParamToQueryOptions('count');	//for serverside purposes count is useless

            try{
                var mQuery = queryBuilder(model, clientQuery);
            }catch(e){
                return e;   //building of the query failed
            }

            if (!mQuery.exec) {
                return new Error('query builder has returned invalid query');
            }
            var socket = this;

            var qKey = JSON.stringify(clientQuery);
            var LQ = liveQueries[qKey];
            var def;

            var pushListeners = function (LQOpts) {
                socket.clientChannelPromise.then(function (clFns) {
                    var activeClientQueryIndexes = Object.keys(socket.registeredLQs);

                    if (activeClientQueryIndexes.length > maxLQsPerClient) {
                        def.reject(new Error('Limit for queries per client reached. Try stopping some live queries.'));
                        return;
                    }

                    var resolveFn = function () {
                        var retVal;
                        if (LQOpts.hasOwnProperty('count')) {
                            retVal = {count: LQ.docs.length, index: LQIndex};
                        } else {
                            retVal = {docs: LQ.docs, index: LQIndex};
                        }

                        def.resolve(retVal);

                        socket.registeredLQs[LQIndex] = LQ;

                        LQ.listeners[socket.id] = {rpcChannel: clFns, socket: socket, clIndex: LQIndex, qOpts: LQOpts};
                    };

                    if (LQ.firstExecDone) {
                        resolveFn();
                    } else {
                        LQ.firstExecPromise.then(resolveFn);
                    }

                }, function (err) {
                    def.reject(err);
                });

            };
            if (LQ) {
                pushListeners(queryOptions);
            } else {
                LQ = new LiveQuery(qKey, mQuery, clientQuery);
                liveQueries[qKey] = LQ;

                LQ.firstExecPromise = mQuery.exec().then(function (rDocs) {
                    LQ.firstExecDone = true;
                    if (clientQuery.hasOwnProperty('findOne')) {
                        if (rDocs) {
                            LQ.docs = [rDocs];
                        } else {
                            LQ.docs = [];
                        }
                    } else {
                        var i = rDocs.length;
                        while(i--)
                        {
                            LQ.docs[i] = rDocs[i];
                        }
                    }

                    return rDocs;

                }, function (err) {
                    logger.error("First LiveQuery exec failed with err " + err);
                    def.reject(err);
                });

                pushListeners(queryOptions);
            }
            return def.promise;
        },
        //TODO have a method to stop and resume liveQuery
        //subscribe
        sub: subscribe,
        subAll: subscribeAll
    };

    if (opts && opts.readOnly !== true) {
        _.extend(channel, {
            create: function (newDoc) {
                if (!opts.checkPermission(this, 'C')) {
                    return new Error('You lack a privilege to create this document');
                }
                opts.dataTransform(newDoc, 'W', this);
                if (schema.paths.owner) {
                    //we should set the owner field if it is present
                    newDoc.owner = this.manager.user._id;
                }
                return model.create(newDoc);

            },
            remove: function (id) {

                var def = Promise.defer();
                var socket = this;
                model.findById(id, function (err, doc) {
                    if (err) {
                        def.reject(new Error('Error occured on the findById query'));
                    }
                    if (doc) {
                        if (opts.checkPermission(socket, 'D', doc)) {
                            doc.remove(function (err) {
                                if (err) {
                                    def.reject(err);
                                }
                                def.resolve();
                            });
                        } else {
                            def.reject(new Error('You lack a privilege to delete this document'));
                        }
                    } else {
                        def.reject(new Error('no document to remove found with _id: ' + id));
                    }
                });
                return def.promise;
            },
            update: function (toUpdate) {

                var def = Promise.defer();
                var socket = this;
                var id = toUpdate._id;
                delete toUpdate._id;
                if (toUpdate.hasOwnProperty('__v')) {
                    delete toUpdate.__v;
                }
                model.findById(id, function (err, doc) {
                    if (doc) {
                        if (opts.checkPermission(socket, 'U', doc)) {
                            opts.dataTransform(toUpdate, 'W', socket);
                            var previousVersion = doc.toObject();
                            _.extend(doc, toUpdate);
                            doc.__v += 1;
                            schema.eventBus.fire.call(doc, 'preupdate', previousVersion);

                            doc.save(function (err) {
                                if (err) {
                                    def.reject(err);
                                }
                                def.resolve();
                            });
                        } else {
                            def.reject(new Error('You lack a privilege to update this document'));
                        }

                    } else {
                        def.reject(new Error('no document to update found with _id: ' + id));
                    }
                });
                return def.promise;
            }
        });
    }
    var authFn = opts && opts.authFn;

    return function exposeCallback() {
        var chnlSockets = rpc.expose('MR-' + modelName, channel, authFn);
        chnlSockets.on('connection', function (socket) {

            socket.clientChannelPromise = rpc.loadClientChannel(socket, 'MR-' + modelName).then(function (clFns) {
                socket.cRpcChnl = clFns;	// client RPC channel
                return clFns;
            });
            socket.registeredLQs = [];
            socket.on('disconnect', function() {
                //clearing out liveQueries listeners
                for (var LQId in socket.registeredLQs) {
                    var LQ = socket.registeredLQs[LQId];
                    LQ.removeListener(socket);
                }
            });
        });

        logger.info('Model %s was exposed', modelName);

        return {modelName: modelName, queries: liveQueries}; // returning for health check
    };

};

module.exports = expose;


