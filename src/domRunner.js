import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';

import JSDOMDomProvider from './JSDOMDomProvider';
import Logger, { logTag } from './Logger';
import MultipleErrors from './MultipleErrors';
import constructReport from './constructReport';
import createDynamicEntryPoint from './createDynamicEntryPoint';
import createStaticPackage from './createStaticPackage';
import createWebpackBundle from './createWebpackBundle';
import ensureTarget from './ensureTarget';
import loadCSSFile from './loadCSSFile';
import prepareAssetsPackage from './prepareAssetsPackage';
import processSnapsInBundle from './processSnapsInBundle';
import uploadAssets from './uploadAssets';

const knownAssetPackagePaths = {};

const { VERBOSE = 'false' } = process.env;

function logTargetResults({ name, globalCSS, snapPayloads, project }) {
  const cssPath = path.join(os.tmpdir(), `happo-verbose-${project}-${name}.css`);
  const snippetsPath = path.join(
    os.tmpdir(),
    `happo-snippets-${project}-${name}.json`,
  );
  fs.writeFileSync(cssPath, JSON.stringify(globalCSS));
  fs.writeFileSync(snippetsPath, JSON.stringify(snapPayloads));
  console.log(
    `${logTag(project)}Recorded CSS for target "${name}" can be found in ${cssPath}`,
  );
  console.log(
    `${logTag(
      project,
    )}Recorded HTML snippets for target "${name}" can be found in ${snippetsPath}`,
  );
}

function waitForAnyKey() {
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();

  return new Promise((resolve) => {
    process.stdin.once('keypress', (_, key) => {
      if (key.ctrl && key.name === 'c') {
        process.exit();
      } else {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        resolve();
      }
    });
  });
}

function resolveDomProvider({ plugins, jsdomOptions }) {
  const pluginWithProvider = plugins.find(({ DomProvider }) => !!DomProvider);
  if (pluginWithProvider) {
    return pluginWithProvider.DomProvider;
  }
  return JSDOMDomProvider.bind(JSDOMDomProvider, jsdomOptions);
}

async function executeTargetWithPrerender({
  name,
  targets,
  globalCSS,
  snapPayloads,
  apiKey,
  apiSecret,
  endpoint,
  isAsync,
  project,
  assetsPackage,
}) {
  if (!snapPayloads.length) {
    console.warn(`${logTag(project)}No examples found for target ${name}, skipping`);
    return [];
  }
  if (VERBOSE === 'true') {
    logTargetResults({ name, globalCSS, snapPayloads, project });
  }

  const result = await ensureTarget(targets[name]).execute({
    asyncResults: isAsync,
    targetName: name,
    assetsPackage,
    globalCSS,
    snapPayloads,
    apiKey,
    apiSecret,
    endpoint,
  });
  return result;
}

async function uploadStaticPackage({
  tmpdir,
  publicFolders,
  endpoint,
  apiKey,
  apiSecret,
  logger,
  project,
}) {
  const { buffer, hash } = await createStaticPackage({
    tmpdir,
    publicFolders,
  });

  const assetsPath = await uploadAssets(buffer, {
    apiKey,
    apiSecret,
    endpoint,
    hash,
    logger,
    project,
  });
  return assetsPath;
}

async function generateScreenshots(
  {
    apiKey,
    apiSecret,
    stylesheets,
    endpoint,
    targets,
    publicFolders,
    jsdomOptions,
    plugins,
    prerender,
    tmpdir,
    isAsync,
    project,
  },
  bundleFile,
  logger,
) {
  const cssBlocks = await Promise.all(
    stylesheets.map(async (sheet) => {
      const { source, id, conditional } =
        typeof sheet === 'string' ? { source: sheet } : sheet;
      const result = {
        source,
        css: await loadCSSFile(source),
      };
      if (id) result.id = id;
      if (conditional) result.conditional = conditional;
      return result;
    }),
  );
  plugins.forEach(({ css }) => {
    if (css) {
      cssBlocks.push({ css });
    }
  });

  const targetNames = Object.keys(targets);
  const tl = targetNames.length;
  const DomProvider = resolveDomProvider({ plugins, jsdomOptions });
  logger.info(
    `${logTag(project)}Generating screenshots in ${tl} target${
      tl > 1 ? 's' : ''
    }...`,
  );
  try {
    const staticPackage = prerender
      ? undefined
      : await uploadStaticPackage({
          tmpdir,
          publicFolders,
          apiKey,
          apiSecret,
          endpoint,
          logger,
          project,
        });

    let results;
    if (prerender) {
      const prerenderPromises = [];
      for (const name of targetNames) {
        // These tasks are CPU-bound, and we need to be careful about how much
        // memory we are using at one time, so we want to run them serially.
        const { css, snapPayloads } = await processSnapsInBundle(bundleFile, {
          targetName: name,
          publicFolders,
          viewport: targets[name].viewport,
          DomProvider,
        });

        const errors = snapPayloads.filter((p) => p.isError);
        if (errors.length === 1) {
          throw errors[0];
        }
        if (errors.length > 1) {
          throw new MultipleErrors(errors);
        }

        const globalCSS = cssBlocks.concat([{ css }]);

        const { buffer, hash } = await prepareAssetsPackage({
          globalCSS,
          snapPayloads,
          publicFolders,
        });

        let assetsPackage = knownAssetPackagePaths[hash];
        if (assetsPackage) {
          if (VERBOSE === 'true') {
            console.log(
              `${logTag(project)}Assets package ${hash} has already been uploaded`,
            );
          }
        } else {
          if (VERBOSE === 'true') {
            console.log(`${logTag(project)}Uploading assets package ${hash}`);
          }
          assetsPackage = await uploadAssets(buffer, {
            endpoint,
            apiKey,
            apiSecret,
            hash,
            logger,
            project,
          });
          knownAssetPackagePaths[hash] = assetsPackage;
        }

        snapPayloads.forEach((item) => {
          delete item.assetPaths;
        });

        const promise = (async () => {
          const startTime = Date.now();
          const result = await executeTargetWithPrerender({
            name,
            globalCSS,
            snapPayloads,
            targets,
            assetsPackage,
            viewport: targets[name].viewport,
            apiKey,
            apiSecret,
            endpoint,
            logger,
            isAsync,
            project,
          });
          logger.start(`  - ${logTag(project)}${name}`, { startTime });
          logger.success();
          return { name, result };
        })();

        prerenderPromises.push(promise);
        if (isAsync) {
          // If we're processing things asynchronously, we wait for the request
          // to finish before moving to the next. This will ease up on
          // concurrency which will help large payloads.
          await promise;
        }
      }

      results = await Promise.all(prerenderPromises);
    } else {
      results = await Promise.all(
        targetNames.map(async (name) => {
          const startTime = Date.now();
          const result = await targets[name].execute({
            asyncResults: isAsync,
            targetName: name,
            staticPackage,
            globalCSS: cssBlocks,
            apiKey,
            apiSecret,
            endpoint,
          });
          logger.start(`  - ${logTag(project)}${name}`, { startTime });
          logger.success();
          return { name, result };
        }),
      );
    }
    if (isAsync) {
      return results;
    }
    return constructReport(results);
  } catch (e) {
    logger.fail();
    throw e;
  }
}

export default async function domRunner(
  {
    apiKey,
    apiSecret,
    setupScript,
    customizeWebpackConfig,
    stylesheets,
    include,
    endpoint,
    targets,
    publicFolders,
    rootElementSelector,
    renderWrapperModule,
    prerender,
    type,
    plugins,
    tmpdir,
    jsdomOptions,
    asyncTimeout,
    project,
    webpack,
  },
  { only, isAsync, onReady },
) {
  const boundGenerateScreenshots = generateScreenshots.bind(null, {
    apiKey,
    apiSecret,
    stylesheets,
    endpoint,
    targets,
    publicFolders,
    prerender,
    only,
    isAsync,
    jsdomOptions,
    plugins,
    tmpdir,
    project,
  });
  const logger = new Logger();

  logger.start(`${logTag(project)}Searching for happo test files...`);
  let entryFile;
  try {
    const entryPointResult = await createDynamicEntryPoint({
      setupScript,
      include,
      only,
      type,
      plugins,
      tmpdir,
      rootElementSelector,
      renderWrapperModule,
      asyncTimeout,
    });
    entryFile = entryPointResult.entryFile;
    logger.success(`${entryPointResult.numberOfFilesProcessed} found`);
  } catch (e) {
    logger.fail(e);
    throw e;
  }

  const debugIndexHtml = fs.readFileSync(path.resolve(__dirname, 'debug.html'));
  fs.writeFileSync(path.resolve(tmpdir, 'index.html'), debugIndexHtml);

  logger.start(`${logTag(project)}Creating bundle...`);

  if (onReady) {
    let currentBuildPromise;
    let currentLogger;
    let currentWaitPromise;
    // We're in dev/watch mode
    createWebpackBundle(
      entryFile,
      { type, customizeWebpackConfig, plugins, tmpdir, webpack },
      {
        onBuildReady: async (bundleFile) => {
          if (currentBuildPromise) {
            currentBuildPromise.cancelled = true;
            currentLogger.mute();
            if (currentWaitPromise) {
              currentWaitPromise.cancelled = true;
            } else {
              logger.divider();
              logger.info('Changes detected. Press any key to continue.');
            }
            const waitPromise = waitForAnyKey();
            currentWaitPromise = waitPromise;
            await waitPromise;
            if (waitPromise.cancelled) {
              return;
            }
            logger.divider();
          } else {
            logger.success();
          }
          currentWaitPromise = undefined;
          const mutableLogger = new Logger();
          const buildPromise = boundGenerateScreenshots(bundleFile, mutableLogger);
          currentLogger = mutableLogger;
          currentBuildPromise = buildPromise;
          try {
            const report = await buildPromise;
            if (!buildPromise.cancelled) {
              onReady(report);
            }
          } catch (e) {
            logger.error(e);
          }
        },
      },
    );
    return;
  }

  const bundleFile = await createWebpackBundle(
    entryFile,
    { type, customizeWebpackConfig, plugins, tmpdir, webpack },
    {},
  );

  logger.success();
  return boundGenerateScreenshots(bundleFile, logger);
}
