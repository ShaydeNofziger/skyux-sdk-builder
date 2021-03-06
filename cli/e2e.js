/*jslint node: true */
'use strict';

const fs = require('fs-extra');
const glob = require('glob');
const path = require('path');
const selenium = require('selenium-standalone');
const protractorLauncher = require('protractor/built/launcher');
const logger = require('@blackbaud/skyux-logger');

const build = require('./utils/run-build');
const server = require('./utils/server');
const configResolver = require('./utils/config-resolver');
const chromeDriverManager = require('./utils/chromedriver-manager');

let seleniumServer;
let start;

function getChromeDriver(argv) {
  return argv.chromeDriver;
}

/**
 * Handles killing off the selenium and webpack servers.
 * @name killServers
 */
function killServers(exitCode) {
  logger.info('Cleaning up running servers');

  if (seleniumServer) {
    logger.info('Closing selenium server');
    seleniumServer.kill();
    seleniumServer = null;
  }

  server.stop();
  logger.info(`Execution Time: ${(new Date().getTime() - start) / 1000} seconds`);
  logger.info(`Exiting process with ${exitCode}`);
  process.exit(exitCode || 0);
}

/**
 * Spawns the protractor command.
 * Perhaps this should be API driven?
 * @name spawnProtractor
 */
function spawnProtractor(argv, configPath, chunks, port, skyPagesConfig) {
  logger.info('Running Protractor');

  const opts = {
    params: {
      localUrl: `https://localhost:${port}`,
      chunks: chunks,
      skyPagesConfig: skyPagesConfig
    }
  };

  const chromeDriver = getChromeDriver(argv);

  if (chromeDriver) {
    logger.info('Using provided chromeDriver', chromeDriver);
    opts.chromeDriver = chromeDriver;
  }

  protractorLauncher.init(configPath, opts);
  process.on('exit', killServers);
}

/**
 * Spawns the selenium server if directConnect is not enabled.
 * @name spawnSelenium
 */
function spawnSelenium(argv, configPath) {

  const config = require(configPath).config;
  const chromeDriver = getChromeDriver(argv);

  return new Promise((resolve, reject) => {
    logger.info('Spawning selenium...');

    // Assumes we're running selenium ourselves, so we should prep it
    if (config.seleniumAddress) {
      logger.info('Installing Selenium...');
      selenium.install({ logger: logger.info }, () => {
        logger.info('Selenium installed. Starting...');
        selenium.start((err, child) => {
          if (err) {
            reject(err);
            return;
          }

          seleniumServer = child;
          logger.info('Selenium server is ready.');
          resolve();
        });
      });

    // Otherwise we need to prep protractor's selenium
    } else if (chromeDriver) {

      logger.info('Skipping webdriver-manager update.');
      resolve();

    } else {

      chromeDriverManager.update()
        .then(() => resolve())
        .catch(err => reject(err));
    }
  });
}

/**
 * Spawns the build process.  Captures the config used.
 */
function spawnBuild(argv, skyPagesConfig, webpack) {

  if (argv.build === false) {
    logger.info('Skipping build step');

    const file = 'dist/metadata.json';
    if (!fs.existsSync(file)) {
      logger.info(`Unable to skip build step.  "${file}" not found.`);
    } else {
      return Promise.resolve({
        metadata: fs.readJsonSync(file)
      });
    }
  }

  return build(argv, skyPagesConfig, webpack)
    .then(stats => stats.toJson().chunks);
}

/**
 * Spawns the necessary commands for e2e.
 * Assumes build was ran.
 * @name e2e
 */
function e2e(command, argv, skyPagesConfig, webpack) {
  start = new Date().getTime();
  process.on('SIGINT', killServers);

  const specsPath = path.resolve(process.cwd(), 'e2e/**/*.e2e-spec.ts');
  const specsGlob = glob.sync(specsPath);
  const configPath = configResolver.resolve(command, argv);

  if (specsGlob.length === 0) {
    logger.info('No spec files located. Skipping e2e command.');
    return killServers(0);
  }

  server.start(argv)
    .then((port) => {
      argv.assets = 'https://localhost:' + port;

      // The assets URL is built by combining the assets URL above with
      // the app's root directory, but in e2e tests the assets files
      // are served directly from the root.  This will back up a directory
      // so that asset URLs are built relative to the root rather than
      // the app's root directory.
      argv.assetsrel = '../';

      return Promise
        .all([
          spawnBuild(argv, skyPagesConfig, webpack),
          port,
          spawnSelenium(argv, configPath)
        ]);
    })
    .then(([chunks, port]) => {
      spawnProtractor(
        argv,
        configPath,
        chunks,
        port,
        skyPagesConfig
      );
    })
    .catch(err => {
      logger.error(err);
      killServers(1);
    });
}

module.exports = e2e;
