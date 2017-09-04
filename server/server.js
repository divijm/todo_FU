var express = require('express');
var fs = require("fs");
var rimraf = require("rimraf");
var mkdirp = require("mkdirp");
var multiparty = require('multiparty');
var http = require('http');
var bodyParser = require('body-parser');
var logger = require('morgan');
var cors = require('cors');
var SuperLogin = require('superlogin');

// paths/constants
var fileInputName = process.env.FILE_INPUT_NAME || "qqfile";
var publicDir = process.env.PUBLIC_DIR;
var nodeModulesDir = process.env.NODE_MODULES_DIR;
var uploadedFilesPath = process.env.UPLOADED_FILES_DIR;
var chunkDirName = "chunks";
// var port = process.env.SERVER_PORT || 8000;
var maxFileSize = process.env.MAX_FILE_SIZE || 0; // in bytes, 0 for unlimited
 
var app = express();
app.set('port', process.env.PORT || 3000);
app.use(logger('dev'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(cors());

// // routes
// app.use(express.static(publicDir));
// app.use("/node_modules", express.static(nodeModulesDir));
app.post("/uploads", onUpload);
app.delete("/uploads/:uuid", onDeleteFile);

app.use(function(req, res, next) {
   res.header("Access-Control-Allow-Origin", "*");
   res.header('Access-Control-Allow-Methods', 'DELETE, PUT');
   res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
   next();
});

var config = {
  dbServer: {
    protocol: 'http://',
    host: 'localhost:5984',
    user: '',
    password: '',
    userDB: 'sl-users',
    couchAuthDB: '_users'
  },
  mailer: {
    fromEmail: 'gmail.user@gmail.com',
    options: {
      service: 'Gmail',
        auth: {
          user: 'gmail.user@gmail.com',
          pass: 'userpass'
        }
    }
  },
  security: {
    maxFailedLogins: 3,
    lockoutTime: 600,
    tokenLife: 86400,
    loginOnRegistration: true,
  },
  userDBs: {
    defaultDBs: {
      private: ['supertest']
    }
  },
  providers: { 
    local: true 
  }
}

function onUpload(req, res) {
  var form = new multiparty.Form();

  form.parse(req, function(err, fields, files) {
      var partIndex = fields.qqpartindex;

      // text/plain is required to ensure support for IE9 and older
      res.set("Content-Type", "text/plain");

      if (partIndex == null) {
          onSimpleUpload(fields, files[fileInputName][0], res);
      }
      else {
          onChunkedUpload(fields, files[fileInputName][0], res);
      }
  });
}

function onSimpleUpload(fields, file, res) {
  var uuid = fields.qquuid,
      responseData = {
          success: false
      };

  file.name = fields.qqfilename;

  if (isValid(file.size)) {
      moveUploadedFile(file, uuid, function() {
              responseData.success = true;
              res.send(responseData);
          },
          function() {
              responseData.error = "Problem copying the file!";
              res.send(responseData);
          });
  }
  else {
      failWithTooBigFile(responseData, res);
  }
}

function onChunkedUpload(fields, file, res) {
  var size = parseInt(fields.qqtotalfilesize),
      uuid = fields.qquuid,
      index = fields.qqpartindex,
      totalParts = parseInt(fields.qqtotalparts),
      responseData = {
          success: false
      };

  file.name = fields.qqfilename;

  if (isValid(size)) {
      storeChunk(file, uuid, index, totalParts, function() {
          if (index < totalParts - 1) {
              responseData.success = true;
              res.send(responseData);
          }
          else {
              combineChunks(file, uuid, function() {
                      responseData.success = true;
                      res.send(responseData);
                  },
                  function() {
                      responseData.error = "Problem conbining the chunks!";
                      res.send(responseData);
                  });
          }
      },
      function(reset) {
          responseData.error = "Problem storing the chunk!";
          res.send(responseData);
      });
  }
  else {
      failWithTooBigFile(responseData, res);
  }
}

function failWithTooBigFile(responseData, res) {
  responseData.error = "Too big!";
  responseData.preventRetry = true;
  res.send(responseData);
}

function onDeleteFile(req, res) {
  var uuid = req.params.uuid,
      dirToDelete = uploadedFilesPath + uuid;

  rimraf(dirToDelete, function(error) {
      if (error) {
          console.error("Problem deleting file! " + error);
          res.status(500);
      }

      res.send();
  });
}

function isValid(size) {
  return maxFileSize === 0 || size < maxFileSize;
}

function moveFile(destinationDir, sourceFile, destinationFile, success, failure) {
  mkdirp(destinationDir, function(error) {
      var sourceStream, destStream;

      if (error) {
          console.error("Problem creating directory " + destinationDir + ": " + error);
          failure();
      }
      else {
          sourceStream = fs.createReadStream(sourceFile);
          destStream = fs.createWriteStream(destinationFile);

          sourceStream
              .on("error", function(error) {
                  console.error("Problem copying file: " + error.stack);
                  destStream.end();
                  failure();
              })
              .on("end", function(){
                  destStream.end();
                  success();
              })
              .pipe(destStream);
      }
  });
}

function moveUploadedFile(file, uuid, success, failure) {
  var destinationDir = uploadedFilesPath + uuid + "/",
      fileDestination = destinationDir + file.name;

  moveFile(destinationDir, file.path, fileDestination, success, failure);
}

function storeChunk(file, uuid, index, numChunks, success, failure) {
  var destinationDir = uploadedFilesPath + uuid + "/" + chunkDirName + "/",
      chunkFilename = getChunkFilename(index, numChunks),
      fileDestination = destinationDir + chunkFilename;

  moveFile(destinationDir, file.path, fileDestination, success, failure);
}

function combineChunks(file, uuid, success, failure) {
  var chunksDir = uploadedFilesPath + uuid + "/" + chunkDirName + "/",
      destinationDir = uploadedFilesPath + uuid + "/",
      fileDestination = destinationDir + file.name;


  fs.readdir(chunksDir, function(err, fileNames) {
      var destFileStream;

      if (err) {
          console.error("Problem listing chunks! " + err);
          failure();
      }
      else {
          fileNames.sort();
          destFileStream = fs.createWriteStream(fileDestination, {flags: "a"});

          appendToStream(destFileStream, chunksDir, fileNames, 0, function() {
              rimraf(chunksDir, function(rimrafError) {
                  if (rimrafError) {
                      console.log("Problem deleting chunks dir! " + rimrafError);
                  }
              });
              success();
          },
          failure);
      }
  });
}

function appendToStream(destStream, srcDir, srcFilesnames, index, success, failure) {
  if (index < srcFilesnames.length) {
      fs.createReadStream(srcDir + srcFilesnames[index])
          .on("end", function() {
              appendToStream(destStream, srcDir, srcFilesnames, index + 1, success, failure);
          })
          .on("error", function(error) {
              console.error("Problem appending chunk! " + error);
              destStream.end();
              failure();
          })
          .pipe(destStream, {end: false});
  }
  else {
      destStream.end();
      success();
  }
}

function getChunkFilename(index, count) {
  var digits = new String(count).length,
      zeros = new Array(digits + 1).join("0");

  return (zeros + index).slice(-digits);
}

 
// Initialize SuperLogin 
var superlogin = new SuperLogin(config);
 
// Mount SuperLogin's routes to our app 
app.use('/auth', superlogin.router);
 
app.listen(app.get('port'));
console.log("App listening on " + app.get('port'));