// All required modules
var express = require("express");
var router = express.Router()
var CryptoJS = require("crypto-js");
var aws = require("aws-sdk");

var fs = require("fs");
var rimraf = require("rimraf");
var mkdirp = require("mkdirp");
var multiparty = require('multiparty');

var http = require('http');
// var routes = require('./routes')
// var user = require('./routes/user')
// var path = require('path')
var bodyParser = require('body-parser');
var logger = require('morgan');
// var multer = require('multer')
// var errorHandler = require('errorhandler')
var cors = require('cors');
var SuperLogin = require('superlogin');

var app = express();

// All enviornments 
app.set('port', process.env.PORT || 3000);
// app.set('views', path.join(__dirname, 'views'));
app.use(logger('dev'));
// app.use(express.static(path.join(__dirname, 'public')))
app.use(express.static(__dirname)); //only needed if serving static content as well
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));
// app.use(multer())
// app.use(cors());

app.listen(app.get('port'));
console.log("App listening on " + app.get('port'));


var clientSecretKey = process.env.CLIENT_SECRET_KEY;

// These two keys are only needed if you plan on using the AWS SDK
// var serverPublicKey = process.env.SERVER_PUBLIC_KEY;
// var serverSecretKey = process.env.SERVER_SECRET_KEY;

// Set these two values to match your environment
var expectedBucket = "fineuploader-test-attachment";
var expectedHostname = "http://fineuploader-test-attachment.s3.amazonaws.com" ;

// CHANGE TO INTEGERS TO ENABLE POLICY DOCUMENT VERIFICATION ON FILE SIZE
// (recommended)
var expectedMinSize = null;
var expectedMaxSize = null;
// EXAMPLES DIRECTLY BELOW:
//expectedMinSize = 0,
//expectedMaxSize = 15000000,

var s3;

// Init S3, given your server-side keys.  Only needed if using the AWS SDK.
// aws.config.update({
// accessKeyId: serverPublicKey,
// secretAccessKey: serverSecretKey
// });
// s3 = new aws.S3();

// Handles all signature requests and the success request FU S3 sends after the file is in S3
// You will need to adjust these paths/conditions based on your setup.
app.post("/server", function(req, res) {
if (typeof req.query.success !== "undefined") {
    verifyFileInS3(req, res);
}
else {
    signRequest(req, res);
}
});

// Handles the standard DELETE (file) request sent by Fine Uploader S3.
// Omit if you don't want to support this feature.
// app.delete("/s3handler/*", function(req, res) {
//     deleteFile(req.query.bucket, req.query.key, function(err) {
//         if (err) {
//             console.log("Problem deleting file: " + err);
//             res.status(500);
//         }

//         res.end();
//     });
// });

// error handling middleware should be loaded after the loading the routes
// if (app.get('env') === 'development') {
//     app.use(errorHandler())
//   }

// Signs any requests.  Delegate to a more specific signer based on type of request.
function signRequest(req, res) {
    if (req.body.headers) {
        signRestRequest(req, res);
    }
    else {
        signPolicy(req, res);
    }
}

// Signs multipart (chunked) requests.  Omit if you don't want to support chunking.
function signRestRequest(req, res) {
    var version = req.query.v4 ? 4 : 2,
        stringToSign = req.body.headers,
        signature = version === 4 ? signV4RestRequest(stringToSign) : signV2RestRequest(stringToSign);

    var jsonResponse = {
        signature: signature
    };

    res.setHeader("Content-Type", "application/json");

    if (isValidRestRequest(stringToSign, version)) {
        res.end(JSON.stringify(jsonResponse));
    }
    else {
        res.status(400);
        res.end(JSON.stringify({invalid: true}));
    }
}

function signV2RestRequest(headersStr) {
    return getV2SignatureKey(clientSecretKey, headersStr);
}

function signV4RestRequest(headersStr) {
    var matches = /.+\n.+\n(\d+)\/(.+)\/s3\/aws4_request\n([\s\S]+)/.exec(headersStr),
        hashedCanonicalRequest = CryptoJS.SHA256(matches[3]),
        stringToSign = headersStr.replace(/(.+s3\/aws4_request\n)[\s\S]+/, '$1' + hashedCanonicalRequest);

    return getV4SignatureKey(clientSecretKey, matches[1], matches[2], "s3", stringToSign);
}

// Signs "simple" (non-chunked) upload requests.
function signPolicy(req, res) {
    var policy = req.body,
        base64Policy = new Buffer(JSON.stringify(policy)).toString("base64"),
        signature = req.query.v4 ? signV4Policy(policy, base64Policy) : signV2Policy(base64Policy);

    var jsonResponse = {
        policy: base64Policy,
        signature: signature
    };

    res.setHeader("Content-Type", "application/json");

    if (isPolicyValid(req.body)) {
        res.end(JSON.stringify(jsonResponse));
    }
    else {
        res.status(400);
        res.end(JSON.stringify({invalid: true}));
    }
}

function signV2Policy(base64Policy) {
    return getV2SignatureKey(clientSecretKey, base64Policy);
}

function signV4Policy(policy, base64Policy) {
    var conditions = policy.conditions,
        credentialCondition;

    for (var i = 0; i < conditions.length; i++) {
        credentialCondition = conditions[i]["x-amz-credential"];
        if (credentialCondition != null) {
            break;
        }
    }

    var matches = /.+\/(.+)\/(.+)\/s3\/aws4_request/.exec(credentialCondition);
    return getV4SignatureKey(clientSecretKey, matches[1], matches[2], "s3", base64Policy);
}

// Ensures the REST request is targeting the correct bucket.
// Omit if you don't want to support chunking.
function isValidRestRequest(headerStr, version) {
    if (version === 4) {
        return new RegExp("host:" + expectedHostname).exec(headerStr) != null;
    }

    return new RegExp("\/" + expectedBucket + "\/.+$").exec(headerStr) != null;
}

// Ensures the policy document associated with a "simple" (non-chunked) request is
// targeting the correct bucket and the min/max-size is as expected.
// Comment out the expectedMaxSize and expectedMinSize variables near
// the top of this file to disable size validation on the policy document.
function isPolicyValid(policy) {
    var bucket, parsedMaxSize, parsedMinSize, isValid;

    policy.conditions.forEach(function(condition) {
        if (condition.bucket) {
            bucket = condition.bucket;
        }
        else if (condition instanceof Array && condition[0] === "content-length-range") {
            parsedMinSize = condition[1];
            parsedMaxSize = condition[2];
        }
    });

    isValid = bucket === expectedBucket;

    // If expectedMinSize and expectedMax size are not null (see above), then
    // ensure that the client and server have agreed upon the exact same
    // values.
    if (expectedMinSize != null && expectedMaxSize != null) {
        isValid = isValid && (parsedMinSize === expectedMinSize.toString())
            && (parsedMaxSize === expectedMaxSize.toString());
    }

    return isValid;
}

// After the file is in S3, make sure it isn't too big.
// Omit if you don't have a max file size, or add more logic as required.
function verifyFileInS3(req, res) {
    function headReceived(err, data) {
        if (err) {
            res.status(500);
            console.log(err);
            res.end(JSON.stringify({error: "Problem querying S3!"}));
        }
        else if (expectedMaxSize != null && data.ContentLength > expectedMaxSize) {
            res.status(400);
            res.write(JSON.stringify({error: "Too big!"}));
            deleteFile(req.body.bucket, req.body.key, function(err) {
                if (err) {
                    console.log("Couldn't delete invalid file!");
                }

                res.end();
            });
        }
        else {
            res.end();
        }
    }

    callS3("head", {
        bucket: req.body.bucket,
        key: req.body.key
    }, headReceived);
}

function getV2SignatureKey(key, stringToSign) {
    var words = CryptoJS.HmacSHA1(stringToSign, key);
    return CryptoJS.enc.Base64.stringify(words);
}

function getV4SignatureKey(key, dateStamp, regionName, serviceName, stringToSign) {
    var kDate = CryptoJS.HmacSHA256(dateStamp, "AWS4" + key),
        kRegion = CryptoJS.HmacSHA256(regionName, kDate),
        kService = CryptoJS.HmacSHA256(serviceName, kRegion),
        kSigning = CryptoJS.HmacSHA256("aws4_request", kService);

    return CryptoJS.HmacSHA256(stringToSign, kSigning).toString();
}

function deleteFile(bucket, key, callback) {
    callS3("delete", {
        bucket: bucket,
        key: key
    }, callback);
}

function callS3(type, spec, callback) {
    s3[type + "Object"]({
        Bucket: spec.bucket,
        Key: spec.key
    }, callback)
}

// // paths/constants
// var fileInputName = process.env.FILE_INPUT_NAME || "qqfile";
// var publicDir = process.env.PUBLIC_DIR;
// var nodeModulesDir = process.env.NODE_MODULES_DIR;
// var uploadedFilesPath = process.env.UPLOADED_FILES_DIR;
// var chunkDirName = "chunks";
// // var port = process.env.SERVER_PORT || 8000;
// var maxFileSize = process.env.MAX_FILE_SIZE || 0; // in bytes, 0 for unlimited
 
// var app = express();
// app.set('port', process.env.PORT || 3000);
// app.use(logger('dev'));
// app.use(bodyParser.json());
// app.use(bodyParser.urlencoded({ extended: false }));
// app.use(cors());

// // Initialize SuperLogin 
// var superlogin = new SuperLogin(config);

// // Mount SuperLogin's routes to our app 
// app.use('/auth', superlogin.router);

// app.listen(app.get('port'));
// console.log("App listening on " + app.get('port'));

// // // routes
// // app.use(express.static(publicDir));
// // app.use("/node_modules", express.static(nodeModulesDir));
// app.post("/uploads", onUpload);
// app.delete("/uploads/:uuid", onDeleteFile);

// app.use(function(req, res, next) {
//    res.header("Access-Control-Allow-Origin", "*");
//    res.header('Access-Control-Allow-Methods', 'DELETE, PUT');
//    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
//    next();
// });

// var config = {
//   dbServer: {
//     protocol: 'http://',
//     host: 'localhost:5984',
//     user: '',
//     password: '',
//     userDB: 'sl-users',
//     couchAuthDB: '_users'
//   },
//   mailer: {
//     fromEmail: 'gmail.user@gmail.com',
//     options: {
//       service: 'Gmail',
//         auth: {
//           user: 'gmail.user@gmail.com',
//           pass: 'userpass'
//         }
//     }
//   },
//   security: {
//     maxFailedLogins: 3,
//     lockoutTime: 600,
//     tokenLife: 86400,
//     loginOnRegistration: true,
//   },
//   userDBs: {
//     defaultDBs: {
//       private: ['supertest']
//     }
//   },
//   providers: { 
//     local: true 
//   }
// }

// function onUpload(req, res) {
//   var form = new multiparty.Form();

//   form.parse(req, function(err, fields, files) {
//       var partIndex = fields.qqpartindex;

//       // text/plain is required to ensure support for IE9 and older
//       res.set("Content-Type", "text/plain");

//       if (partIndex == null) {
//           onSimpleUpload(fields, files[fileInputName][0], res);
//       }
//       else {
//           onChunkedUpload(fields, files[fileInputName][0], res);
//       }
//   });
// }

// function onSimpleUpload(fields, file, res) {
//   var uuid = fields.qquuid,
//       responseData = {
//           success: false
//       };

//   file.name = fields.qqfilename;

//   if (isValid(file.size)) {
//       moveUploadedFile(file, uuid, function() {
//               responseData.success = true;
//               res.send(responseData);
//           },
//           function() {
//               responseData.error = "Problem copying the file!";
//               res.send(responseData);
//           });
//   }
//   else {
//       failWithTooBigFile(responseData, res);
//   }
// }

// function onChunkedUpload(fields, file, res) {
//   var size = parseInt(fields.qqtotalfilesize),
//       uuid = fields.qquuid,
//       index = fields.qqpartindex,
//       totalParts = parseInt(fields.qqtotalparts),
//       responseData = {
//           success: false
//       };

//   file.name = fields.qqfilename;

//   if (isValid(size)) {
//       storeChunk(file, uuid, index, totalParts, function() {
//           if (index < totalParts - 1) {
//               responseData.success = true;
//               res.send(responseData);
//           }
//           else {
//               combineChunks(file, uuid, function() {
//                       responseData.success = true;
//                       res.send(responseData);
//                   },
//                   function() {
//                       responseData.error = "Problem conbining the chunks!";
//                       res.send(responseData);
//                   });
//           }
//       },
//       function(reset) {
//           responseData.error = "Problem storing the chunk!";
//           res.send(responseData);
//       });
//   }
//   else {
//       failWithTooBigFile(responseData, res);
//   }
// }

// function failWithTooBigFile(responseData, res) {
//   responseData.error = "Too big!";
//   responseData.preventRetry = true;
//   res.send(responseData);
// }

// function onDeleteFile(req, res) {
//   var uuid = req.params.uuid,
//       dirToDelete = uploadedFilesPath + uuid;

//   rimraf(dirToDelete, function(error) {
//       if (error) {
//           console.error("Problem deleting file! " + error);
//           res.status(500);
//       }

//       res.send();
//   });
// }

// function isValid(size) {
//   return maxFileSize === 0 || size < maxFileSize;
// }

// function moveFile(destinationDir, sourceFile, destinationFile, success, failure) {
//   mkdirp(destinationDir, function(error) {
//       var sourceStream, destStream;

//       if (error) {
//           console.error("Problem creating directory " + destinationDir + ": " + error);
//           failure();
//       }
//       else {
//           sourceStream = fs.createReadStream(sourceFile);
//           destStream = fs.createWriteStream(destinationFile);

//           sourceStream
//               .on("error", function(error) {
//                   console.error("Problem copying file: " + error.stack);
//                   destStream.end();
//                   failure();
//               })
//               .on("end", function(){
//                   destStream.end();
//                   success();
//               })
//               .pipe(destStream);
//       }
//   });
// }

// function moveUploadedFile(file, uuid, success, failure) {
//   var destinationDir = uploadedFilesPath + uuid + "/",
//       fileDestination = destinationDir + file.name;

//   moveFile(destinationDir, file.path, fileDestination, success, failure);
// }

// function storeChunk(file, uuid, index, numChunks, success, failure) {
//   var destinationDir = uploadedFilesPath + uuid + "/" + chunkDirName + "/",
//       chunkFilename = getChunkFilename(index, numChunks),
//       fileDestination = destinationDir + chunkFilename;

//   moveFile(destinationDir, file.path, fileDestination, success, failure);
// }

// function combineChunks(file, uuid, success, failure) {
//   var chunksDir = uploadedFilesPath + uuid + "/" + chunkDirName + "/",
//       destinationDir = uploadedFilesPath + uuid + "/",
//       fileDestination = destinationDir + file.name;


//   fs.readdir(chunksDir, function(err, fileNames) {
//       var destFileStream;

//       if (err) {
//           console.error("Problem listing chunks! " + err);
//           failure();
//       }
//       else {
//           fileNames.sort();
//           destFileStream = fs.createWriteStream(fileDestination, {flags: "a"});

//           appendToStream(destFileStream, chunksDir, fileNames, 0, function() {
//               rimraf(chunksDir, function(rimrafError) {
//                   if (rimrafError) {
//                       console.log("Problem deleting chunks dir! " + rimrafError);
//                   }
//               });
//               success();
//           },
//           failure);
//       }
//   });
// }

// function appendToStream(destStream, srcDir, srcFilesnames, index, success, failure) {
//   if (index < srcFilesnames.length) {
//       fs.createReadStream(srcDir + srcFilesnames[index])
//           .on("end", function() {
//               appendToStream(destStream, srcDir, srcFilesnames, index + 1, success, failure);
//           })
//           .on("error", function(error) {
//               console.error("Problem appending chunk! " + error);
//               destStream.end();
//               failure();
//           })
//           .pipe(destStream, {end: false});
//   }
//   else {
//       destStream.end();
//       success();
//   }
// }

// function getChunkFilename(index, count) {
//   var digits = new String(count).length,
//       zeros = new Array(digits + 1).join("0");

//   return (zeros + index).slice(-digits);
// }
