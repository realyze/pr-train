#!/usr/bin/env node

// @ts-check
const simpleGit = require('simple-git/promise');
const difference = require('lodash.difference');
const program = require('commander');
const ProgressBar = require('progress');
const emoji = require('node-emoji');
const fs = require('fs');
const yaml = require('js-yaml');
const { ensurePrsExist, readGHKey } = require('./github');
const colors = require('colors');
const { DEFAULT_REMOTE, MERGE_STEP_DELAY_MS, MERGE_STEP_DELAY_WAIT_FOR_LOCK } = require('./consts');
const path = require('path');
// @ts-ignore
const package = require('./package.json');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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

async function pushChanges(sg, branches, forcePush, remote = DEFAULT_REMOTE) {
  console.log(`Pushing changes to remote ${remote}...`);
  // Ugh... `raw` doesn't allow empty strings or `undefined`s, so let's filter any "empty" args.
  const args = ['push', forcePush ? '--force' : undefined, remote].concat(branches).filter(Boolean);
  await sg.raw(args);
  console.log('All changes pushed ' + emoji.get('white_check_mark'));
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
 * @param {BranchCfg} branchCfg
 */
function getBranchName(branchCfg) {
  return typeof branchCfg === 'string' ? branchCfg : Object.keys(branchCfg)[0];
}

/**
 * @return {Promise.<Array.<BranchCfg>>}
 */
async function getBranchesConfigInCurrentTrain(sg) {
  const branches = await sg.branchLocal();
  const currentBranch = branches.current;
  const { trains } = await loadConfig(sg);
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
    .option('--list', 'List branches in current train')
    .option('-r, --rebase', 'Rebase branches rather than merging them')
    .option('-f, --force', 'Force push to remote')
    .option('--push-merged', 'Push all branches (inclusing those that have already been merged into master)')
    .option('--remote <remote>', 'Set remote to push to. Defaults to "origin"')
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

  if (program.createPrs && !readGHKey()) {
    console.log(`"$HOME/.pr-train" not found. Please make sure file exists and contains your GitHub API key`.red);
    process.exit(4);
  }

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

  const { current: currentBranch, all: allBranches } = await sg.branchLocal();
  const trainCfg = await getBranchesConfigInCurrentTrain(sg);
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
  console.log(
    sortedTrainBranches.map(b => ` -> ${b.green}${b === combinedTrainBranch ? ' (combined)' : ''}`).join('\n'),
    '\n'
  );
  if (program.list) {
    return;
  }

  for (let i = 0; i < sortedTrainBranches.length - 1; ++i) {
    await combineBranches(sg, program.rebase, sortedTrainBranches[i], sortedTrainBranches[i + 1]);
    await sleep(MERGE_STEP_DELAY_MS);
  }

  if (program.push || program.pushMerged) {
    let branchesToPush = sortedTrainBranches;
    if (!program.pushMerged) {
      branchesToPush = await getUnmergedBranches(sg, sortedTrainBranches);
      const branchDiff = difference(sortedTrainBranches, branchesToPush);
      if (branchDiff.length > 0) {
        console.log(`Not pushing already merged branches: ${branchDiff.join(', ')}`);
      }
    }
    pushChanges(sg, branchesToPush, program.force, program.remote);
  }

  if (program.createPrs) {
    await ensurePrsExist(sg, sortedTrainBranches, combinedTrainBranch, program.remote);
  }

  await sg.checkout(currentBranch);
}

main().catch(e => {
  console.log(`${emoji.get('x')}  An error occured. Was there a conflict perhaps?`.red);
  console.error('error', e);
});
