#!/usr/bin/env node

// @ts-check
const simpleGit = require('simple-git/promise');
const difference = require('lodash.difference');
const program = require('commander');
const emoji = require('node-emoji');
const fs = require('fs');
const yaml = require('js-yaml');
const { ensurePrsExist, readGHKey, checkGHKeyExists } = require('./github');
const colors = require('colors');
const {
  DEFAULT_REMOTE,
  DEFAULT_BASE_BRANCH,
  MERGE_STEP_DELAY_MS,
  MERGE_STEP_DELAY_WAIT_FOR_LOCK,
} = require('./consts');
const path = require('path');
// @ts-ignore
const package = require('./package.json');
const inquirer = require('inquirer');
const shelljs = require('shelljs');
const camelCase = require('lodash/camelCase');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Returns `true` is ref `b1` is an ancestor of ref `b2`.
 *
 * @param {simpleGit.SimpleGit} sg
 * @param {string} r1
 * @param {string} r2
 */
function isBranchAncestor(sg, r1, r2) {
  return shelljs.exec(`git merge-base --is-ancestor ${r1} ${r2}`).code === 0;
}

/**
 *
 * @param {simpleGit.SimpleGit} sg
 * @param {boolean} rebase
 * @param {string} from
 * @param {string} to
 */
async function combineBranches(sg, rebase, from, to) {
  if (program.rebase) {
    process.stdout.write(`rebasing ${to} onto branch ${from}... `);
  } else {
    process.stdout.write(`merging ${from} into branch ${to}... `);
  }
  try {
    await sg.checkout(to);
    await (rebase ? sg.rebase([from]) : sg.merge([from]));
  } catch (e) {
    if (!e.conflicts || e.conflicts.length === 0) {
      await sleep(MERGE_STEP_DELAY_WAIT_FOR_LOCK);
      await sg.checkout(to);
      await (rebase ? sg.rebase([from]) : sg.merge([from]));
    }
  }
  console.log(emoji.get('white_check_mark'));
}

async function pushBranches(sg, branches, forcePush, remote = DEFAULT_REMOTE) {
  console.log(`Pushing changes to remote ${remote}...`);
  // Ugh... `raw` doesn't allow empty strings or `undefined`s, so let's filter any "empty" args.
  const args = ['push', forcePush ? '--force' : undefined, remote].concat(branches).filter(Boolean);
  await sg.raw(args);
  console.log('All changes pushed ' + emoji.get('white_check_mark'));
}

async function getUnmergedBranches(sg, branches, baseBranch = DEFAULT_BASE_BRANCH) {
  const mergedBranchesOutput = await sg.raw(['branch', '--merged', baseBranch]);
  const mergedBranches = mergedBranchesOutput
    .split('\n')
    .map(b => b.trim())
    .filter(Boolean);
  return difference(branches, mergedBranches);
}

async function getConfigPath(sg) {
  const repoRootPath = (await sg.raw(['rev-parse', '--show-toplevel'])).trim();
  return `${repoRootPath}/.pr-train.yml`;
}

/**
 * @typedef {string | Object.<string, { combined: boolean, initSha?: string }>} BranchCfg
 * @typedef {Object.<string, Array.<string | BranchCfg>>} TrainCfg
 * @typedef {{ prs?: Object, trains: Array.<TrainCfg>}} YamlCfg
 */

/**
 * @param {simpleGit.SimpleGit} sg
 * @return {Promise.<YamlCfg>}
 */
async function loadConfig(sg) {
  const path = await getConfigPath(sg);
  return yaml.safeLoad(fs.readFileSync(path, 'utf8'));
}

/**
 * @param {BranchCfg} branchCfg
 */
function getBranchName(branchCfg) {
  return typeof branchCfg === 'string' ? branchCfg : Object.keys(branchCfg)[0];
}

/**
 * @return {Promise.<Array.<BranchCfg>>}
 */
async function getBranchesConfigInCurrentTrain(sg, config) {
  const branches = await sg.branchLocal();
  const currentBranch = branches.current;
  const { trains } = config;
  if (!trains) {
    return null;
  }
  const key = Object.keys(trains).find(trainKey => {
    const branches = trains[trainKey];
    const branchNames = branches.map(b => getBranchName(b));
    return branchNames.indexOf(currentBranch) >= 0;
  });
  return key && trains[key];
}

/**
 * @param {Array.<BranchCfg>} branchConfig
 */
function getBranchesInCurrentTrain(branchConfig) {
  return branchConfig.map(b => getBranchName(b));
}

/**
 * @param {Array.<BranchCfg>} branchConfig
 */
function getCombinedBranch(branchConfig) {
  const combinedBranch = /** @type {Object<string, {combined: boolean}>} */ branchConfig.find(cfg => {
    if (!cfg || typeof cfg === 'string') {
      return false;
    }
    const branchName = Object.keys(cfg)[0];
    return cfg[branchName].combined;
  });
  if (!combinedBranch) {
    return undefined;
  }
  const branchName = Object.keys(combinedBranch)[0];
  return branchName;
}

async function handleSwitchToBranchCommand(sg, sortedBranches, combinedBranch) {
  const switchToBranchIndex = program.args[0];
  if (typeof switchToBranchIndex === 'undefined') {
    return;
  }
  let targetBranch;
  if (switchToBranchIndex === 'combined') {
    targetBranch = combinedBranch;
  } else {
    targetBranch = sortedBranches[switchToBranchIndex];
  }
  if (!targetBranch) {
    console.log(`Could not find branch with index ${switchToBranchIndex}`.red);
    process.exit(3);
  }
  await sg.checkout(targetBranch);
  console.log(`Switched to branch ${targetBranch}`);
  process.exit(0);
}

/**
 * @param {YamlCfg} ymlConfig
 * @param {string} path
 */
function getConfigOption(ymlConfig, path) {
  const parts = path.split(/\./g);
  let ptr = ymlConfig;
  while (ptr && parts.length) {
    const part = parts.shift();
    // cater for both kebab case and camel cased variants of key, just for developer convenience.
    ptr = part in ptr ? ptr[part] : ptr[camelCase(part)];
  }
  return ptr;
}

async function main() {
  const sg = simpleGit();
  if (!(await sg.checkIsRepo())) {
    console.log('Not a git repo'.red);
    process.exit(1);
  }

  // try to create or init the config first so we can read values from it
  if (process.argv.includes('--init')) {
    if (fs.existsSync(await getConfigPath(sg))) {
      console.log('.pr-train.yml already exists');
      process.exit(1);
    }
    const root = path.dirname(require.main.filename);
    const cfgTpl = fs.readFileSync(`${root}/cfg_template.yml`);
    fs.writeFileSync(await getConfigPath(sg), cfgTpl);
    console.log(`Created a ".pr-train.yml" file. Please make sure it's gitignored.`);
    process.exit(0);
  }

  let ymlConfig;
  try {
    ymlConfig = await loadConfig(sg);
  } catch (e) {
    if (e instanceof yaml.YAMLException) {
      console.log('There seems to be an error in `.pr-train.yml`.');
      console.log(e.message);
      process.exit(1);
    }
    console.log('`.pr-train.yml` file not found. Please run `git pr-train --init` to create one.'.red);
    process.exit(1);
  }

  const defaultBase = getConfigOption(ymlConfig, 'prs.main-branch-name') || DEFAULT_BASE_BRANCH;
  const draftByDefault = !!getConfigOption(ymlConfig, 'prs.draft-by-default');

  program
    .version(package.version)
    .option('--init', 'Creates a .pr-train.yml file with an example configuration')
    .option('-p, --push', 'Push changes')
    .option('-l, --list', 'List branches in current train')
    .option('-r, --rebase', 'Rebase branches rather than merging them')
    .option('-f, --force', 'Force push to remote')
    .option('--push-merged', 'Push all branches (including those that have already been merged into the base branch)')
    .option('--remote <remote>', 'Set remote to push to. Defaults to "origin"')
    .option('-b, --base <base>', `Specify the base branch to use for the first and combined PRs.`, defaultBase)
    .option('-d, --draft', 'Create PRs in draft mode', draftByDefault)
    .option('--no-draft', 'Do not create PRs in draft mode', !draftByDefault)
    .option('-c, --create-prs', 'Create GitHub PRs from your train branches');

  program.on('--help', () => {
    console.log('');
    console.log('  Switching branches:');
    console.log('');
    console.log(
      '    $ `git pr-train <index>` will switch to branch with index <index> (e.g. 0 or 5). ' +
        'If <index> is "combined", it will switch to the combined branch.'
    );
    console.log('');
    console.log('  Creating GitHub PRs:');
    console.log('');
    console.log(
      '    $ `git pr-train -p --create-prs` will create GH PRs for all branches in your train (with a "table of contents")'
    );
    console.log(
      colors.italic(
        `    Please note you'll need to create a \`\${HOME}/.pr-train\` file with your GitHub access token first.`
      )
    );
    console.log('');
  });

  program.parse(process.argv);

  program.createPrs && checkGHKeyExists();

  const baseBranch = program.base; // will have default value if one is not supplied

  const draft = program.draft != null ? program.draft : draftByDefault;

  const { current: currentBranch, all: allBranches } = await sg.branchLocal();
  const trainCfg = await getBranchesConfigInCurrentTrain(sg, ymlConfig);
  if (!trainCfg) {
    console.log(`Current branch ${currentBranch} is not a train branch.`);
    process.exit(1);
  }
  const sortedTrainBranches = getBranchesInCurrentTrain(trainCfg);
  const combinedTrainBranch = getCombinedBranch(trainCfg);

  if (combinedTrainBranch && !allBranches.includes(combinedTrainBranch)) {
    const lastBranchBeforeCombined = sortedTrainBranches[sortedTrainBranches.length - 2];
    await sg.raw(['branch', combinedTrainBranch, lastBranchBeforeCombined]);
  }

  await handleSwitchToBranchCommand(sg, sortedTrainBranches, combinedTrainBranch);

  console.log(`I've found these partial branches:`);
  const branchesToPrint = sortedTrainBranches.map((b, idx) => {
    const branch = b === currentBranch ? `${b.green.bold}` : b;
    const suffix = b === combinedTrainBranch ? ' (combined)' : '';
    return `[${idx}] ${branch}${suffix}`;
  });

  if (program.list) {
    const answer = await inquirer.prompt([
      {
        type: 'list',
        name: 'branch',
        message: 'Select a branch to checkout',
        choices: branchesToPrint.map((b, i) => ({ name: b, value: sortedTrainBranches[i] })),
        pageSize: 20,
      },
    ]);
    console.log(`checking out branch ${answer.branch}`);
    await sg.checkout(answer.branch);
    return;
  }

  console.log(branchesToPrint.map(b => ` -> ${b}`).join('\n'), '\n');

  async function findAndPushBranches() {
    let branchesToPush = sortedTrainBranches;
    if (!program.pushMerged) {
      branchesToPush = await getUnmergedBranches(sg, sortedTrainBranches, baseBranch);
      const branchDiff = difference(sortedTrainBranches, branchesToPush);
      if (branchDiff.length > 0) {
        console.log(`Not pushing already merged branches: ${branchDiff.join(', ')}`);
      }
    }
    pushBranches(sg, branchesToPush, program.force, program.remote);
  }

  // If we're creating PRs, don't combine branches (that might change branch HEADs and consequently
  // the PR titles and descriptions). Just push and create the PRs.
  if (program.createPrs) {
    await findAndPushBranches();
    await ensurePrsExist({
      sg,
      allBranches: sortedTrainBranches,
      combinedBranch: combinedTrainBranch,
      remote: program.remote,
      draft,
      baseBranch,
      printLinks: getConfigOption(ymlConfig, 'prs.print-urls'),
    });
    return;
  }

  for (let i = 0; i < sortedTrainBranches.length - 1; ++i) {
    const b1 = sortedTrainBranches[i];
    const b2 = sortedTrainBranches[i + 1];
    if (isBranchAncestor(sg, b1, b2)) {
      console.log(`Branch ${b1} is an ancestor of ${b2} => nothing to do`);
      continue;
    }
    await combineBranches(sg, program.rebase, b1, b2);
    await sleep(MERGE_STEP_DELAY_MS);
  }

  if (program.push || program.pushMerged) {
    await findAndPushBranches();
  }

  await sg.checkout(currentBranch);
}

main().catch(e => {
  console.log(`${emoji.get('x')}  An error occurred. Was there a conflict perhaps?`.red);
  console.error('error', e);
});
