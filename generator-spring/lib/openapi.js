/*
 * Copyright IBM Corporation 2017
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// module for generating code from open api document

const http = require('http');
const request = require('request');
const Promise = require('bluebird');
var unzip = require('unzip2');
const requestAsync = Promise.promisify(request)
const fs = require('fs');
const path = require('path');
const os = require('os');
const log = require('@arf/java-common').log;
Promise.promisifyAll(request);

const sdkGenURL = 'https://mobilesdkgen.stage1.ng.bluemix.net/sdkgen/api/generator/';
const sdkGenCheckDelay = 3000;

var logger = log;

var generate = function(docs, parentLogger) {
    logger = parentLogger || log;
    logger.writeToLog('Spring Generator generating code from open api document');
    var openApiDir = [];
    var p = new Promise((resolve, reject) => {
        var i = 0;
        docs.forEach(doc => {
            generateFromDoc(doc.spec)
            .then(sdk => {
                openApiDir.push(sdk);
                if (++i === docs.length) {
                resolve(openApiDir);
                }
            });
        });
    });
    return p;
}

var generateFromDoc = function(doc) {
    return performSDKGenerationAsync('testSpringSDK', 'server_java_spring_boot', doc)
        .then(generatedID => {
            logger.writeToLog('Spring Generator generated code from open api document with id ' + generatedID);
            return getServerSDKAsync('testSpringSDK', generatedID)
        });
}

var writeFiles = function(dirs, generator) {
    dirs.forEach(sdk => {
        generator.fs.copy(path.join(sdk.tempDir, 'generated-code', 'javaSpring', 'src'), generator.destinationPath('src'));
    });
}

var performSDKGenerationAsync = function (sdkName, sdkType, fileContent) {
  var startGenURL = `${sdkGenURL}${sdkName}/${sdkType}`
  logger.writeToLog(`starting SDK generation job for ${sdkName} using ${startGenURL}`)
  return request.postAsync({
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    },
    url: startGenURL,
    body: fileContent
  })
    .then(function (response) {
      var body = JSON.parse(response.body)
      if (body.job && body.job.id) {
        return body.job.id
      }
      throw new Error('SDK generation error:', response.statusCode, response.statusMessage, body.message)
    })
    .tap(generatedID => logger.writeToLog(`SDK generation job for ${sdkName} started with id ${generatedID}`))
    .then(generatedID => checkUntilFinished(generatedID))

  function checkUntilFinished (generatedID, count) {
    count = count || 1
    logger.writeToLog(`#${count} checking status of SDK generation job with id ${generatedID} (for ${sdkName})`)
    return getStatusAsync(generatedID)
        .then(finished => {
          if (finished) {
            logger.writeToLog(`SDK generation job with id ${generatedID} (for ${sdkName}) is complete`)
            return generatedID
          } else {
            if (count <= 10) {
              return Promise.delay(sdkGenCheckDelay).then(() => checkUntilFinished(generatedID, count + 1))
            } else {
              throw new Error('Timeout error, couldn\'t generate SDK within timeout.')
            }
          }
        })
  }
}

function getStatusAsync (generatedID) {
  var getStatusURL = `${sdkGenURL}${generatedID}/status`
  return requestAsync({
    headers: { 'Accept': 'application/json' },
    url: getStatusURL
  })
    .then(response => {
      var status = JSON.parse(response.body).status
      switch (status) {
        case 'FINISHED':
          return true

        case 'VALIDATION_FAILED':
        case 'FAILED':
          throw new Error('SDK generator creation failed with status: ', status)

        default:
          return false
      }
    })
}

var getServerSDKAsync = function(sdkName, generatedID) {
  var serverDownloadURL = sdkGenURL + generatedID
  // Use the non-async version of request.get() here because
  // we are going to use .pipe() to stream the data to disk
  return new Promise((resolve, reject) => {
    const { sep } = require('path');
    var tempDir = fs.mkdtempSync(os.tmpDir() + sep);
    logger.writeToLog(`starting server SDK download and unzip for ${sdkName} from ${serverDownloadURL} to ${tempDir}`)
    request.get({
      headers: { 'Accept': 'application/zip' },
      url: serverDownloadURL
    })
    .on('error', err => {
      reject(new Error('Getting server SDK failed with error: ', err.message))
    })
    .pipe(unzip.Extract({ path: tempDir }))
    .on('close', () => {
      logger.writeToLog(`finished server SDK download and unzip for ${sdkName} from ${serverDownloadURL} to ${tempDir}`)

      resolve({ tempDir: tempDir, dirname: sdkName })
    })
  })
}

module.exports = {
    generate : generate,
    writeFiles : writeFiles
}