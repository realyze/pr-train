#!/usr/bin/env node

const simpleGit = require('simple-git/promise');
const sortBy = require('lodash.sortby')
const figlet = require('figlet');
const program = require('commander');
const ProgressBar = require('progress');
const package = require('./package.json');

require('colors');

async function mergeBranch(sg, from, to) {
    process.stdout.write(`merging ${from} into branch ${to}...`);
    await sg.checkout(to);
    await sg.merge([from]);
    console.log('done'.green);
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
    const bar = new ProgressBar(' uploading [:bar] :percent :elapsed', {
        width: 20,
        total: branches.length + 1,
        clear: true,
    });
    bar.tick(1);
    const promises = branches.map(b => sg.push(remote, b).then(() => bar.tick(1)));
    await Promise.all(promises);
    console.log('All changes pushed'.green);
}

async function main() {
    program
        .version(package.version)
        .option('-p, --push', 'Push changes')
        .option('-r, --remote <remote>', 'Set remote to push to. Defaults to "origin"')
        .parse(process.argv);

    printTrain();

    const sg = simpleGit();
    if (!await sg.checkIsRepo()) {
        console.log('Not a git repo'.red);
        process.exit(1);
    }
    const branch = await sg.branchLocal();
    const branchRootMatch = branch.current.match(/(.*)\/([0-9]+|combined)\/?.*$/);
    if (!branchRootMatch) {
        console.log(`Current branch is not part of a PR train. Exiting.`.red);
        process.exit(2);
    }
    const branchRoot = branchRootMatch[1];
    const subBranches = branch.all.filter(b => b.indexOf(branchRoot) === 0);
    const numericRegexp = /.*\/([0-9]+)\/?.*$/;
    const sortedBranches = sortBy(
        subBranches.filter(b=>b.match(numericRegexp)),
        branch => branch.match()[1]);

    console.log(`I've found these partial branches:`);
    console.log(sortedBranches.map(b => ` -> ${b.green}`).join('\n'), '\n');
    const mergePromises = [];
    for (let i=0; i<sortedBranches.length - 1; ++i) {
        await mergeBranch(sg, sortedBranches[i], sortedBranches[i+1])
    }
    await Promise.all(mergePromises);

    const combinedBranch = `${branchRoot}/combined`;
    if (!branch.all.find(b => b === combinedBranch)) {
        console.log(`creating combined branch (${combinedBranch})`)
        await sg.checkout(`-b${combinedBranch}`);
    }

    const lastSubBranch = sortedBranches[sortedBranches.length - 1];
    await mergeBranch(sg, lastSubBranch, combinedBranch);

    if (program.push) {
        pushChanges(sg, sortedBranches.concat(combinedBranch), program.remote);
    }
}

main();
