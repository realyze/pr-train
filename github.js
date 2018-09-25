// @ts-check
const octo = require('octonode');
const promptly = require('promptly');
const { DEFAULT_REMOTE } = require('./consts');
const fs = require('fs');
const colors = require('colors');
const emoji = require('node-emoji');

async function constructPrMsg(sg, branch) {
  const title = await sg.raw(['log', '--format=%s', '-n', '1', branch]);
  const body = await sg.raw(['log', '--format=%b', '-n', '1', branch]);
  return {
    title: title.trim(),
    body: body.trim(),
  };
}

function constructTrainNavigation(branchToPrDict, currentBranch, combinedBranch) {
  let contents = '#### PR chain:\n';
  return Object.keys(branchToPrDict).reduce((output, branch) => {
    const maybeHandRight = branch === currentBranch ? '👉 ' : '';
    const maybeHandLeft = branch === currentBranch ? ' 👈 **YOU ARE HERE**' : '';
    const combinedInfo = branch === combinedBranch ? ' **[combined branch]** ' : ' ';
    output += `${maybeHandRight}#${branchToPrDict[branch].pr}${combinedInfo}(${branchToPrDict[
      branch
    ].title.trim()})${maybeHandLeft}`;
    return output + '\n';
  }, contents);
}

function readGHKey() {
  return fs
    .readFileSync(`${process.env.HOME}/.pr-train`, 'UTF-8')
    .toString()
    .trim();
}

async function ensurePrsExist(sg, allBranches, combinedBranch, remote = DEFAULT_REMOTE) {
  //const allBranches = combinedBranch ? sortedBranches.concat(combinedBranch) : sortedBranches;
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
  });

  console.log();
  console.log('This will create (or update) PRs for the following branches:');
  await allBranches.reduce(async (memo, branch) => {
    await memo;
    const { title } = branch === combinedBranch ? getCombinedBranchPrMsg() : await constructPrMsg(sg, branch);
    console.log(`  -> ${branch.green} (${title.italic})`);
  }, Promise.resolve());

  console.log();
  if (!(await promptly.confirm(colors.bold('Shall we do this? [y/n] ')))) {
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
    const { title, body } = branch === combinedBranch ? getCombinedBranchPrMsg() : await constructPrMsg(sg, branch);
    const base = index === 0 || branch === combinedBranch ? 'master' : allBranches[index - 1];
    process.stdout.write(`Checking if PR for branch ${branch} already exists... `);
    const prs = await ghRepo.prsAsync({
      head: `${nick}:${branch}`,
    });
    let prResponse = prs[0] && prs[0][0];
    if (prResponse) {
      console.log('yep');
    } else {
      console.log('nope');
      const payload = {
        head: branch,
        base,
        title,
        body,
      };
      process.stdout.write(`Creating PR for branch "${branch}"...`);
      prResponse = (await ghRepo.prAsync(payload))[0];
      console.log(emoji.get('white_check_mark'));
    }
    memo[branch] = {
      title,
      pr: prResponse.number,
    };
    return memo;
  }, Promise.resolve({}));

  // Now that we have all the PRs, let's update them with the "navigation" section.
  // Note: We're running this serially to have nicer logs.
  await allBranches.reduce(async (memo, branch) => {
    await memo;
    const ghPr = octoClient.pr(nickAndRepo, prDict[branch].pr);
    const { title, body } = branch === combinedBranch ? getCombinedBranchPrMsg() : await constructPrMsg(sg, branch);
    const navigation = constructTrainNavigation(prDict, branch, combinedBranch);
    process.stdout.write(`Updating PR for branch ${branch}...`);
    await ghPr.updateAsync({
      title,
      body: `${body}\n${navigation}`,
    });
    console.log(emoji.get('white_check_mark'));
  }, Promise.resolve());
}

module.exports = {
  ensurePrsExist,
  readGHKey,
};
