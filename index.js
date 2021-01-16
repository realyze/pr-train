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
const { DEFAULT_REMOTE, MERGE_STEP_DELAY_MS, MERGE_STEP_DELAY_WAIT_FOR_LOCK } = require('./consts');
const path = require('path');
// @ts-ignore
const package = require('./package.json');
const inquirer = require('inquirer');
const shelljs = require('shelljs');

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

async function checkoutNewBranch(sg, newBranch){
  try {
    await sg.raw(['checkout', '-b', newBranch]);
  } catch (e) {
    console.log(`${newBranch} is an existing branch... Checking out`)
    await sg.raw(['checkout', newBranch]);
  }
}

async function addCurrentBranchToYmlConfig(sg, atIndex, trainKey, ymlConfig) {  
  const branches = await sg.branchLocal();
  const currentBranch = branches.current;
  const { trains } = ymlConfig;
  if (trains[trainKey].indexOf(currentBranch) >=0) {
    console.log(`${currentBranch} is already in this train`)
    return null
  } else {
    const newYmlConfig = JSON.parse(JSON.stringify(ymlConfig));
    const branchConfigs = newYmlConfig.trains[trainKey];
    branchConfigs.splice(atIndex, 0, currentBranch);
    return newYmlConfig;
  }
}

async function getUnmergedBranches(sg, branches) {
  const mergedBranchesOutput = await sg.raw(['branch', '--merged', 'master']);
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
 */

/**
 * @param {simpleGit.SimpleGit} sg
 * @return {Promise.<{trains: Array.<TrainCfg>}>}
 */
async function loadConfig(sg) {
  const path = await getConfigPath(sg);
  return yaml.safeLoad(fs.readFileSync(path, 'utf8'));
}

/**
 * @param {simpleGit.SimpleGit} sg
 * @param {trains: Array.<TrainCfg>} sg
 */
async function saveConfig(sg, ymlConfig) {
  const path = await getConfigPath(sg);
  fs.writeFileSync(path, yaml.safeDump(ymlConfig))
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
async function getCurrentBranchIndex(sg, trainCfg) {
  const branches = await sg.branchLocal();
  return trainCfg.map(b => getBranchName(b)).indexOf(branches.current);
}

function getKeyOfTrain(trainCgf, ymlConfig) {
  const { trains } = ymlConfig;
  return Object.keys(trains).find(trainKey => {
    return trains[trainKey] === trainCgf;
  });
}
/**
 * @param {Array.<BranchCfg>} branchConfig
 */
function getCombinedBranch(branchConfig) {
  const combinedBranch = /** @type {Object<string, {combined: boolean}>} */ branchConfig.find(cfg => {
    if (typeof cfg === 'string') {
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

async function main() {
  program
    .version(package.version)
    .option('--init', 'Creates a .pr-train.yml file with an example configuration')
    .option('-p, --push', 'Push changes')
    .option('-l, --list', 'List branches in current train')
    .option('-r, --rebase', 'Rebase branches rather than merging them')
    .option('-f, --force', 'Force push to remote')
    .option('--push-merged', 'Push all branches (inclusing those that have already been merged into master)')
    .option('--remote <remote>', 'Set remote to push to. Defaults to "origin"')
    .option('-c, --create-prs', 'Create GitHub PRs from your train branches')
    .option('-n, --new-branch <branch>', 'Create a new branch to the train and place it after the current branch');

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

  const sg = simpleGit();
  if (!(await sg.checkIsRepo())) {
    console.log('Not a git repo'.red);
    process.exit(1);
  }

  if (program.init) {
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
      branchesToPush = await getUnmergedBranches(sg, sortedTrainBranches);
      const branchDiff = difference(sortedTrainBranches, branchesToPush);
      if (branchDiff.length > 0) {
        console.log(`Not pushing already merged branches: ${branchDiff.join(', ')}`);
      }
    }
    pushBranches(sg, branchesToPush, program.force, program.remote);
  }
  
  if (program.newBranch) {
    const trainKey = getKeyOfTrain(trainCfg, ymlConfig);
    const currentBranchIndex = await getCurrentBranchIndex(sg, trainCfg);
    const newBranchIndex = currentBranchIndex + 1;
    await checkoutNewBranch(sg, program.newBranch);
    const newYmlConfig = await addCurrentBranchToYmlConfig(sg, newBranchIndex, trainKey, ymlConfig);
    if (newYmlConfig) {
      await saveConfig(sg, newYmlConfig);
      console.log(`${program.newBranch} added to the train after ${currentBranch}`)
    }
    return;
  }

  // If we're creating PRs, don't combine branches (that might change branch HEADs and consequently
  // the PR titles and descriptions). Just push and create the PRs.
  if (program.createPrs) {
    await findAndPushBranches();
    await ensurePrsExist(sg, sortedTrainBranches, combinedTrainBranch, program.remote);
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
  console.log(`${emoji.get('x')}  An error occured. Was there a conflict perhaps?`.red);
  console.error('error', e);
});
