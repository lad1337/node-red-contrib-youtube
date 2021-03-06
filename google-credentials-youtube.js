module.exports = function(RED) {
    "use strict";
    var request = require('request');
    var crypto = require("crypto");
    var url = require('url');

    function GoogleNode(n) {
        RED.nodes.createNode(this,n);
        this.displayName = n.displayName;
    }
    RED.nodes.registerType("google-credentials-youtube",GoogleNode,{
        credentials: {
            displayName: {type:"text"},
            clientId: {type:"text"},
            clientSecret: {type:"password"},
            accessToken: {type:"password"},
            refreshToken: {type:"password"},
            expireTime: {type:"password"}
        }
    });

    GoogleNode.prototype.refreshToken = function(cb) {
        var credentials = this.credentials;
        var node = this;
        //console.log("refreshing token: " + credentials.refreshToken);
        if (!credentials.refreshToken) {
            node.error(RED._("google.error.no-refresh-token"));
            return cb(RED._("google.error.no-refresh-token"));
        }
        request.post({
            url: 'https://accounts.google.com/o/oauth2/token',
            json: true,
            form: {
                grant_type: 'refresh_token',
                client_id: credentials.clientId,
                client_secret: credentials.clientSecret,
                refresh_token: credentials.refreshToken,
            },
        }, function(err, result, data) {
            if (err) {
                node.error(RED._("google.error.token-request-error", {err: err}));
                return;
            }
            if (data.error) {
                node.error(RED._("google.error.refresh-token-error", {message: data.error.message}));
                return;
            }
            // console.log("refreshed: " + require('util').inspect(data));
            credentials.accessToken = data.access_token;
            if (data.refresh_token) {
                credentials.refreshToken = data.refresh_token;
            }
            credentials.expiresIn = data.expires_in;
            credentials.expireTime =
                data.expires_in + (new Date().getTime()/1000);
            credentials.tokenType = data.token_type;
            RED.nodes.addCredentials(node.id, credentials);
            if (typeof cb !== undefined) {
                cb();
            }
        });
    };

    GoogleNode.prototype.request = function(req, retries, cb) {
        var node = this;
        if (typeof retries === 'function') {
            cb = retries;
            retries = 1;
        }
        if (typeof req !== 'object') {
            req = { url: req };
        }
        req.method = req.method || 'GET';
        if (!req.hasOwnProperty("json")) {
            req.json = true;
        }
        // always set access token to the latest ignoring any already present
        req.auth = { bearer: this.credentials.accessToken };
        //console.log(require('util').inspect(req));
        if (!this.credentials.expireTime ||
            this.credentials.expireTime < (new Date().getTime()/1000)) {
            if (retries === 0) {
                node.error(RED._("google.error.too-many-refresh-attempts"));
                cb(RED._("google.error.too-many-refresh-attempts"));
                return;
            }
            node.warn(RED._("google.warn.token-expired"));
            node.refreshToken(function (err) {
                if (err) {
                    return;
                }
                node.request(req, 0, cb);
            });
            return;
        }
        request(req, function(err, result, data) {
            if (err) {
                // handled in callback
            } else if (result.statusCode >= 400) {
                data = {
                    error: {
                        code: result.statusCode,
                        message: result.body,
                    },
                };
            } else if (data.error) {
                if (data.error.code === 401 && retries > 0) {
                    retries--;
                    node.warn(RED._("google.warn.refreshing-accesstoken"));
                    node.refreshToken(function (err) {
                        if (err) {
                            return cb(err, null);
                        }
                        return node.request(req, retries, cb);
                    });
                }
            }
            cb(err, data);
        });
    };

    RED.httpAdmin.get('/google-credentials-youtube/auth', function(req, res){
        if (!req.query.clientId || !req.query.clientSecret ||
            !req.query.id || !req.query.callback) {
            res.send(400);
            return;
        }
        var node_id = req.query.id;
        var callback = req.query.callback;
        var credentials = {
            clientId: req.query.clientId,
            clientSecret: req.query.clientSecret
        };

        var gScopes = 'https://www.googleapis.com/auth/youtube https://www.googleapis.com/auth/userinfo.profile';
        var csrfToken = crypto.randomBytes(18).toString('base64').replace(/\//g, '-').replace(/\+/g, '_');
        credentials.csrfToken = csrfToken;
        credentials.callback = callback;
        res.cookie('csrf', csrfToken);
        res.redirect(url.format({
            protocol: 'https',
            hostname: 'accounts.google.com',
            pathname: '/o/oauth2/auth',
            query: {
                response_type: 'code',
                client_id: credentials.clientId,
                state: node_id + ":" + csrfToken,
                access_type: 'offline',
                approval_prompt: 'force',
                //scope : 'profile ' + gPlusScopes,
                scope : gScopes,
                // TODO: include_granted_scopes: 'true', ?
                redirect_uri: callback
            }
        }));
        RED.nodes.addCredentials(node_id, credentials);
    });

    RED.httpAdmin.get('/google-credentials-youtube/auth/callback', function(req, res) {
        if (req.query.error) {
            return res.send(RED._("google.error.error", {error: req.query.error, description: req.query.error_description}));
        }
        var state = req.query.state.split(':');
        var node_id = state[0];
        var credentials = RED.nodes.getCredentials(node_id);
        if (!credentials || !credentials.clientId || !credentials.clientSecret) {
            console.log("credentials not present?");
            return res.send(RED._("google.error.no-credentials"));
        }
        if (state[1] !== credentials.csrfToken) {
            return res.status(401).send(
                RED._("google.error.token-mismatch")
            );
        }

        request.post({
            url: 'https://accounts.google.com/o/oauth2/token',
            json: true,
            form: {
                grant_type: 'authorization_code',
                code: req.query.code,
                client_id: credentials.clientId,
                client_secret: credentials.clientSecret,
                redirect_uri: credentials.callback
            },
        }, function(err, result, data) {
            if (err) {
                console.log("request error:" + err);
                return res.send(RED._("google.error.something-broke"));
            }
            if (data.error) {
                console.log("oauth error: " + data.error);
                return res.send(RED._("google.error.something-broke"));
            }
            credentials.accessToken = data.access_token;
            credentials.refreshToken = data.refresh_token;
            credentials.expiresIn = data.expires_in;
            credentials.expireTime =
                data.expires_in + (new Date().getTime()/1000);
            credentials.tokenType = data.token_type;
            delete credentials.csrfToken;
            delete credentials.callback;
            RED.nodes.addCredentials(node_id, credentials);
            request.get({
                url: 'https://www.googleapis.com/plus/v1/people/me',
                json: true,
                auth: { bearer: credentials.accessToken },
            }, function(err, result, data) {
                if (err) {
                    console.log('fetching google profile failed: ' + err);
                    return res.send("auth worked but profile fetching failed");
                }
                if (data.error) {
                    console.log('fetching google profile failed: ' +
                                data.error.message);
                    return res.send(RED._("google.error.profile-fetch-failed"));
                }
                credentials.displayName = data.displayName;
                RED.nodes.addCredentials(node_id, credentials);
                res.send(RED._("google.message.authorized"));
            });
        });
    });
};
