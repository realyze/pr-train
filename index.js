const simpleGit = require('simple-git/promise');
const sortBy = require('lodash.sortby')
const figlet = require('figlet');
require('colors');

async function mergeBranch(sg, from, to) {
    process.stdout.write(`merging ${from} into branch ${to}...`);
    await sg.checkout(from);
    await sg.merge([to]);
    console.log('done'.green);
}

async function main() {
    console.log('==================================================')
    console.log(figlet.textSync('PR train', {
        font: 'Train',
        horizontalLayout: 'default',
        verticalLayout: 'default'
    }));
    console.log('==================================================\n')
    const sg = simpleGit();
    const branch = await sg.branchLocal();
    const branchRoot = branch.current.match(/(.*)\/([0-9]+|combined)\/?.*$/)[1];
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
    mergeBranch(sg, lastSubBranch, combinedBranch);
}

main();
