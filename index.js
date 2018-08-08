#!/usr/bin/env node
//@ts-check

const simpleGit = require('simple-git/promise');
const sortBy = require('lodash.sortby')
const difference = require('lodash.difference')
const figlet = require('figlet');
const program = require('commander');
const ProgressBar = require('progress');
const emoji = require('node-emoji')
const package = require('./package.json');
const octo = require('octonode');
const fs = require('fs');
const promptly = require('promptly');
const { printQuote } = require('./quotes');

const colors = require('colors');

const MERGE_STEP_DELAY_MS = 500;
const MERGE_STEP_DELAY_WAIT_FOR_LOCK = 1500;

const DEFAULT_REMOTE = 'origin';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function combineBranches(sg, rebase, from, to) {
    if (program.rebase) {
        process.stdout.write(`rebasing ${to} onto branch ${from}... `);
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

async function pushChanges(sg, branches, remote = DEFAULT_REMOTE) {
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

function getBranchRoot(branches) {
    const branchRootMatch = branches.current.match(/(.*)\/([0-9]+|combined)\/?.*$/);
    if (!branchRootMatch) {
        console.log(`Current branch is not part of a PR train. Exiting.`.red);
        process.exit(2);
    }
    return branchRootMatch[1];
}

function getSortedTrainBranches(branches, branchRoot) {
    const subBranches = branches.all.filter(b => b.indexOf(branchRoot) === 0);
    const numericRegexp = /.*\/([0-9]+)\/?.*$/;
    const sortedBranches = sortBy(
        subBranches.filter(b => b.match(numericRegexp)),
        branch => parseInt(branch.match(numericRegexp)[1], 10));
    return sortedBranches;
}

async function constructPrMsg(sg, branch) {
    const title = await sg.raw(['log', '--format=%s', '-n', '1', branch]);
    const body = await sg.raw(['log', '--format=%b', '-n', '1', branch]);
    return {title: title.trim(), body: body.trim()};
}

function constructTrainNavigation(branchToPrDict, currentBranch) {
    let contents = '#### PR chain:\n'
    return Object.keys(branchToPrDict).reduce((output, branch) => {
        output += `#${branchToPrDict[branch].pr} (${branchToPrDict[branch].title.trim()})`
        if (branch === currentBranch) {
            output += ' <- you are here'
        }
        return output + '\n'
    }, contents);
}

function readGHKey() {
    return fs.readFileSync(`${process.env.HOME}/.pr-train`, 'UTF-8').toString().trim();
}

async function ensurePrsExist(sg, sortedBranches, combinedBranch, remote = DEFAULT_REMOTE) {
    const allBranches = combinedBranch ? sortedBranches.concat(combinedBranch) : sortedBranches;
    const octoClient = octo.client(readGHKey());
    // TODO: take remote name from `-r` value.
    const remoteUrl = await sg.raw(['config', '--get', `remote.${remote}.url`]);
    if (!remoteUrl) {
        console.log(`URL for remote ${remote} not found in your git config`.red);
        process.exit(4);
    }

    let combinedBranchTitle;
    if (combinedBranch) {
        console.log();
        console.log(`Now I will need to know what to call your "combined" branch PR in GitHub.`);
        combinedBranchTitle = await promptly.prompt(colors.bold(`Combined branch PR title:`));
        if (!combinedBranchTitle) {
            console.log(`Cannot continue.`.red, `(I need to know what the title of your combined branch PR should be.)`);
            process.exit(5);
        }
    }

    const getCombinedBranchPrMsg = () => ({
        title: combinedBranchTitle,
        body: '',
    })

    console.log();
    console.log('This will create (or update) PRs for the following branches:')
    await allBranches.reduce(async (memo, branch) => {
        await memo;
        const {title} = branch === combinedBranch
            ? getCombinedBranchPrMsg()
            : await constructPrMsg(sg, branch);
        console.log(`  -> ${branch.green} (${title.italic})`);
    }, Promise.resolve());

    console.log();
    if (!await promptly.confirm(colors.bold('Shall we do this? [y/n] '))) {
        console.log('No worries. Bye now.', emoji.get('wave'));
        process.exit(0);
    }

    const nickAndRepo = remoteUrl.match(/:(.*)\.git/)[1];
    if (!nickAndRepo) {
        console.log(`I could not parse your remote ${remote} repo URL`.red);
        process.exit(4);
    }

    const nick = nickAndRepo.split('/')[0];
    const ghRepo = octoClient.repo(nickAndRepo);

    console.log('');
    // Construct branch_name <-> PR_data mapping.
    // Note: We're running this serially to have nicer logs.
    const prDict = await allBranches.reduce(async (_memo, branch, index) => {
        const memo = await _memo;
        const {title, body} = branch === combinedBranch
            ? getCombinedBranchPrMsg()
            : await constructPrMsg(sg, branch);
        const base = (index === 0 || branch === combinedBranch) ? 'master' : allBranches[index - 1];
        process.stdout.write(`Checking if PR for branch ${branch} already exists... `);
        const prs = await ghRepo.prsAsync({head: `${nick}:${branch}`})
        let prResponse = prs[0] && prs[0][0];
        if (prResponse) {
            console.log('yep');
        } else {
            console.log('nope');
            const payload = { head: branch, base, title, body };
            process.stdout.write(`Creating PR for branch "${branch}"...`)
            prResponse = (await ghRepo.prAsync(payload))[0];
            console.log(emoji.get('white_check_mark'));
        }
        memo[branch] = {
            title,
            pr: prResponse.number,
        };
        return memo;
    }, Promise.resolve({}));

    console.log('');
    console.log(`Waiting for GitHub database gnomes... ${emoji.get('pick')}`)
    console.log('');
    await sleep(1000);

    // Now that we have all the PRs, let's update them with the "navigation" section.
    // Note: We're running this serially to have nicer logs.
    await allBranches.reduce(async (memo, branch) => {
        await memo;
        const ghPr = octoClient.pr(nickAndRepo, prDict[branch].pr);
        const {title, body} = branch === combinedBranch
            ? getCombinedBranchPrMsg()
            : await constructPrMsg(sg, branch);
        const navigation = constructTrainNavigation(prDict, branch);
        process.stdout.write(`Updating PR for branch ${branch}...`)
        await ghPr.updateAsync({ title, body: `${body}\n${navigation}` });
        console.log(emoji.get('white_check_mark'));
    }, Promise.resolve());
}

async function main() {
    program
        .version(package.version)
        .option('-p, --push', 'Push changes')
        .option('-r, --rebase', 'Rebase branches rather than merging them')
        .option('--push-merged', 'Push all branches (inclusing those that have already been merged into master)')
        .option('-C, --no-combined', 'Do not create combined branch (or ignore it if already created)')
        .option('--remote <remote>', 'Set remote to push to. Defaults to "origin"')
        .option('--no-quote', 'Do not print wise quote on exit')
        .option('-c, --create-prs', 'Create GitHub PRs from your train branches');

    program.on('--help', () => {
        console.log('');
        console.log('  Switching branches:');
        console.log('');
        console.log('    $ `git pr-train <index>` will switch to branch with index 2');
        console.log('');
        console.log('  Creating GitHub PRs:');
        console.log('');
        console.log('    $ `git pr-train -p --create-prs` will create GH PRs for all branches in your train (with a "table of contents")');
        console.log(colors.italic(`    Please note you'll need to create a \`\${HOME}/.pr-train\` file with your GitHub access token first.`));
        console.log('');
    });

    program.parse(process.argv);

    // Bind listener here to prevent quoting when invoked with `-h`.
    process.on('exit', () => program.quote && printQuote());

    if (program.createPrs && !readGHKey()) {
        console.log(`"$HOME/.pr-train" not found. Please make sure file exists and contains your GitHub API key`.red);
        process.exit(4);
    }

    const sg = simpleGit();
    if (!await sg.checkIsRepo()) {
        console.log('Not a git repo'.red);
        process.exit(1);
    }

    printTrain();

    const branches = await sg.branchLocal();
    const branchRoot = getBranchRoot(branches);
    const sortedBranches = getSortedTrainBranches(branches, branchRoot);

    const switchToBranchIndex = program.args[0];
    if (switchToBranchIndex) {
        const targetBranch = sortedBranches.find(b => b.indexOf(`${branchRoot}/${switchToBranchIndex}`) === 0)
        if (!targetBranch) {
            console.log(`Could not find branch with index ${switchToBranchIndex}`.red);
            process.exit(3);
        }
        await sg.checkout(targetBranch);
        console.log(`Switched to branch ${targetBranch}`);
        return;
    }

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

    if (program.createPrs) {
        await ensurePrsExist(sg, sortedBranches, combinedBranch, program.remote);
    }

    await sg.checkout(branches.current);
}

main().catch((e) => {
    console.log(`${emoji.get('x')}  An error occured. Was there a conflict perhaps?`.red);
    console.error('error', e);
});
