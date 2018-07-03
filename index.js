#!/usr/bin/env node

const simpleGit = require('simple-git/promise');
const sortBy = require('lodash.sortby')
const difference = require('lodash.difference')
const figlet = require('figlet');
const program = require('commander');
const ProgressBar = require('progress');
const emoji = require('node-emoji')
const package = require('./package.json');

require('colors');

const MERGE_STEP_DELAY_MS = 500;
const MERGE_STEP_DELAY_WAIT_FOR_LOCK = 1500;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function combineBranches(sg, rebase, from, to) {
    if (program.rebase) {
        process.stdout.write(`rebasing ${from} onto branch ${to}... `);
    } else {
        process.stdout.write(`merging ${from} into branch ${to}... `);
    }
    await sg.checkout(to);
    try {
        await rebase ? sg.rebase ([from]) : sg.merge([from]);
    } catch (e) {
        if (!e.conflicts || e.conflicts.length === 0) {
            await sleep(MERGE_STEP_DELAY_WAIT_FOR_LOCK);
            await rebase ? sg.rebase ([from]) : sg.merge([from]);
        }
    }
    console.log(emoji.get('white_check_mark'));
}

function printTrain() {
    console.log(figlet.textSync('PR train', {
        font: 'Train',
        horizontalLayout: 'default',
        verticalLayout: 'default'
    }));
    console.log("=".repeat(65) + '\n');
}

async function pushChanges(sg, branches, remote = 'origin') {
    console.log(`Pushing changes to remote ${remote}...`);
    const bar = new ProgressBar('Pushing [:bar] :percent :elapsed', {
        width: 20,
        total: branches.length + 1,
        clear: true,
    });
    bar.tick(1);
    const promises = branches.map(b => sg.push(remote, b).then(() => bar.tick(1)));
    await Promise.all(promises);
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

async function main() {
    program
        .version(package.version)
        .option('-p, --push', 'Push changes')
        .option('-r, --rebase', 'Rebase branches rather than merging them')
        .option('--push-merged', 'Push even branches merged into master')
        .option('-C, --no-combined', 'Do not create combined branch (or ignore it if already created)')
        .option('--remote <remote>', 'Set remote to push to. Defaults to "origin"')
        .parse(process.argv);

    printTrain();

    const sg = simpleGit();
    if (!await sg.checkIsRepo()) {
        console.log('Not a git repo'.red);
        process.exit(1);
    }
    const branches = await sg.branchLocal();
    const branchRootMatch = branches.current.match(/(.*)\/([0-9]+|combined)\/?.*$/);
    if (!branchRootMatch) {
        console.log(`Current branch is not part of a PR train. Exiting.`.red);
        process.exit(2);
    }
    const branchRoot = branchRootMatch[1];
    const subBranches = branches.all.filter(b => b.indexOf(branchRoot) === 0);
    const numericRegexp = /.*\/([0-9]+)\/?.*$/;
    const sortedBranches = sortBy(
        subBranches.filter(b => b.match(numericRegexp)),
        branch => parseInt(branch.match(numericRegexp)[1], 10));

    console.log(`I've found these partial branches:`);
    console.log(sortedBranches.map(b => ` -> ${b.green}`).join('\n'), '\n');
    const mergePromises = [];
    for (let i=0; i<sortedBranches.length - 1; ++i) {
        await combineBranches(sg, program.rebase, sortedBranches[i], sortedBranches[i+1]);
        await sleep(MERGE_STEP_DELAY_MS);
    }
    await Promise.all(mergePromises);

    let combinedBranch;
    if (program.combined) {
        combinedBranch = `${branchRoot}/combined`;
        if (!program.noCombined && !branches.all.find(b => b === combinedBranch)) {
            console.log(`creating combined branch (${combinedBranch})`)
            await sg.checkout(`-b${combinedBranch}`);
        }
        const lastSubBranch = sortedBranches[sortedBranches.length - 1];
        await combineBranches(sg, program.rebase, lastSubBranch, combinedBranch);
        await sleep(MERGE_STEP_DELAY_MS);
    }

    if (program.push || program.pushMerged) {
        const allBranches = combinedBranch ? sortedBranches.concat(combinedBranch) : sortedBranches;
        let branchesToPush = allBranches;
        if (!program.pushMerged) {
            branchesToPush = await getUnmergedBranches(sg, allBranches);
            const branchDiff = difference(allBranches, branchesToPush);
            if (branchDiff.length > 0) {
                console.log(`Not pushing already merged branches: ${branchDiff.join(', ')}`);
            }
        }
        pushChanges(sg, branchesToPush, program.remote);
    }

    await sg.checkout(branches.current);
}

main().catch((e) => {
    console.log(`${emoji.get('x')}  An error occured. Was there a conflict perhaps?`.red);
});
